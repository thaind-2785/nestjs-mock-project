import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { RetentionWindowConfiguration } from '../config/retention.config';
import type { RetentionDuePredicate } from './retention-due';
import type {
  RetentionEventBatch,
  RetentionExportBatch,
} from './retention.types';

/**
 * The statements that actually remove rows.
 *
 * Three rules hold across all of them.
 *
 * Bounded: every delete carries `LIMIT`, and the predicate is applied before it, so a
 * batch is a prefix of what is due rather than a page of what might be. A run loops
 * batches until nothing is due or its budget is spent.
 *
 * Committed per batch: nothing here opens a transaction spanning more than one step of
 * one batch. A run that is interrupted has deleted less, not deleted wrongly, and the
 * next run resumes from the same due query.
 *
 * Ordered: children before parents, always. Where the schema enforces it the failure is
 * a rejected statement; where it does not - `email_send_attempts` carries no foreign key
 * to `outbox_events`, because an FK insert would take a shared lock on the row a
 * recovering worker may hold exclusively - the failure is invisible, and only a test
 * that counts orphans can see it.
 */
@Injectable()
export class RetentionDeleteRepository {
  /**
   * Applies the declared statement bound for one read, and resets it afterwards.
   *
   * Reads only, because `MAX_EXECUTION_TIME` bounds nothing else: MySQL ignores it for a
   * `DELETE`, which is bounded by its `LIMIT` and the index behind its predicate
   * instead. The two claim reads below are exactly what it does bound, so they are
   * exactly where it is applied - an earlier version of this file wrote the helper and
   * called it from nowhere, which left `RETENTION_STATEMENT_TIMEOUT` unreachable and a
   * configured bound enforcing nothing.
   *
   * The reset is in `finally` because the session outlives this query.
   */
  private withStatementBound<T>(
    dataSource: DataSource,
    statementTimeoutMs: number,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    // The transaction is what pins the connection. `SET SESSION` belongs to one, and an
    // unpinned manager borrows a different connection per call - so the bound could land
    // on one, the read run unbounded on another, and the reset apply to a third, leaving
    // the first carrying a ceiling for whatever feature draws it next.
    return dataSource.transaction(async (manager) => {
      await manager.query('SET SESSION MAX_EXECUTION_TIME = ?', [
        statementTimeoutMs,
      ]);
      try {
        return await work(manager);
      } finally {
        await manager.query('SET SESSION MAX_EXECUTION_TIME = DEFAULT');
      }
    });
  }

  /**
   * Bounds how long a delete inside this transaction will wait for a lock.
   *
   * `MAX_EXECUTION_TIME` does not apply to a `DELETE`, so it is not what bounds one -
   * `innodb_lock_wait_timeout` is, and its default of fifty seconds per statement puts a
   * three-step chain well past the worker's drain. Setting it per transaction is what
   * makes the drain arithmetic describe the work rather than assume it.
   */
  async withLockWaitBound<T>(
    manager: EntityManager,
    lockWaitSeconds: number,
    work: () => Promise<T>,
  ): Promise<T> {
    await manager.query('SET SESSION innodb_lock_wait_timeout = ?', [
      lockWaitSeconds,
    ]);
    return work();
  }

  /**
   * A single-table purge: the whole task for the three that have no dependents.
   *
   * Ordered as well as limited. `DELETE ... LIMIT` without `ORDER BY` takes whichever
   * rows the access path reaches first, which for a range scan is usually the oldest but
   * is not promised - and under a permanently full window the oldest could survive while
   * newer rows are collected, invisible in the ledger because the counts look the same.
   */
  async deleteBatch(
    manager: EntityManager,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    batchSize: number,
  ): Promise<number> {
    const result: { affectedRows?: number } = await manager.query(
      `DELETE FROM ${predicate.table}
       WHERE ${predicate.where}
       ORDER BY ${predicate.anchorColumn}, ${predicate.identityColumn}
       LIMIT ?`,
      [...predicate.parameters(windows), batchSize],
    );
    return result.affectedRows ?? 0;
  }

  /** The parent rows one chain batch will work through. */
  async claimEventBatch(
    dataSource: DataSource,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    batchSize: number,
    statementTimeoutMs: number,
  ): Promise<RetentionEventBatch> {
    const rows: Array<{ id: string }> = await this.withStatementBound(
      dataSource,
      statementTimeoutMs,
      (manager) =>
        manager.query(
          `SELECT id FROM ${predicate.table}
           WHERE ${predicate.where}
           ORDER BY ${predicate.anchorColumn}, id
           LIMIT ?`,
          [...predicate.parameters(windows), batchSize],
        ),
    );
    return { eventIds: rows.map((row) => row.id) };
  }

  async claimExportBatch(
    dataSource: DataSource,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    batchSize: number,
    statementTimeoutMs: number,
  ): Promise<RetentionExportBatch> {
    const rows: Array<{
      id: string;
      object_key: string | null;
      outbox_event_id: string;
    }> = await this.withStatementBound(
      dataSource,
      statementTimeoutMs,
      (manager) =>
        manager.query(
          `SELECT id, object_key, outbox_event_id FROM ${predicate.table}
         WHERE ${predicate.where}
         ORDER BY ${predicate.anchorColumn}, id
         LIMIT ?`,
          [...predicate.parameters(windows), batchSize],
        ),
    );
    return {
      jobs: rows.map((row) => ({
        id: row.id,
        objectKey: row.object_key,
        outboxEventId: row.outbox_event_id,
      })),
    };
  }

  /**
   * The step the database will not enforce.
   *
   * `email_send_attempts` has no foreign key, so deleting the event first succeeds and
   * leaves these rows behind with nothing pointing at them and nothing complaining.
   */
  async deleteSendAttempts(
    manager: EntityManager,
    eventIds: string[],
  ): Promise<number> {
    return this.deleteByEventIds(manager, 'email_send_attempts', eventIds);
  }

  async deleteDeliveries(
    manager: EntityManager,
    eventIds: string[],
  ): Promise<number> {
    return this.deleteByEventIds(manager, 'email_deliveries', eventIds);
  }

  async deleteEvents(
    manager: EntityManager,
    eventIds: string[],
  ): Promise<number> {
    if (eventIds.length === 0) return 0;
    const result: { affectedRows?: number } = await manager.query(
      `DELETE FROM outbox_events WHERE id IN (${placeholders(eventIds)})`,
      eventIds,
    );
    return result.affectedRows ?? 0;
  }

  async deleteExportJobs(
    manager: EntityManager,
    jobIds: string[],
  ): Promise<number> {
    if (jobIds.length === 0) return 0;
    const result: { affectedRows?: number } = await manager.query(
      `DELETE FROM export_jobs WHERE id IN (${placeholders(jobIds)})`,
      jobIds,
    );
    return result.affectedRows ?? 0;
  }

  private async deleteByEventIds(
    manager: EntityManager,
    table: 'email_send_attempts' | 'email_deliveries',
    eventIds: string[],
  ): Promise<number> {
    if (eventIds.length === 0) return 0;
    const result: { affectedRows?: number } = await manager.query(
      `DELETE FROM ${table} WHERE outbox_event_id IN (${placeholders(eventIds)})`,
      eventIds,
    );
    return result.affectedRows ?? 0;
  }
}

function placeholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}
