import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
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
   * Applies the declared statement bound for the caller's session.
   *
   * Reads only: MySQL's `MAX_EXECUTION_TIME` does not bound a `DELETE`. What bounds the
   * deletes is the batch size and the index behind the predicate, and what bounds the
   * run as a whole is its budget. Stated here because the distinction is easy to assume
   * away, and the lease argument rests on the budget rather than on this.
   */
  async withStatementBound<T>(
    manager: EntityManager,
    statementTimeoutMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    await manager.query('SET SESSION MAX_EXECUTION_TIME = ?', [
      statementTimeoutMs,
    ]);
    try {
      return await work();
    } finally {
      await manager.query('SET SESSION MAX_EXECUTION_TIME = DEFAULT');
    }
  }

  /** A single-table purge: the whole task for the three that have no dependents. */
  async deleteBatch(
    manager: EntityManager,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    batchSize: number,
  ): Promise<number> {
    const result: { affectedRows?: number } = await manager.query(
      `DELETE FROM ${predicate.table}
       WHERE ${predicate.where}
       LIMIT ?`,
      [...predicate.parameters(windows), batchSize],
    );
    return result.affectedRows ?? 0;
  }

  /** The parent rows one chain batch will work through. */
  async claimEventBatch(
    manager: EntityManager,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    batchSize: number,
  ): Promise<RetentionEventBatch> {
    const rows: Array<{ id: string }> = await manager.query(
      `SELECT id FROM ${predicate.table}
       WHERE ${predicate.where}
       ORDER BY ${predicate.anchorColumn}, id
       LIMIT ?`,
      [...predicate.parameters(windows), batchSize],
    );
    return { eventIds: rows.map((row) => row.id) };
  }

  async claimExportBatch(
    manager: EntityManager,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    batchSize: number,
  ): Promise<RetentionExportBatch> {
    const rows: Array<{
      id: string;
      object_key: string | null;
      outbox_event_id: string;
    }> = await manager.query(
      `SELECT id, object_key, outbox_event_id FROM ${predicate.table}
       WHERE ${predicate.where}
       ORDER BY ${predicate.anchorColumn}, id
       LIMIT ?`,
      [...predicate.parameters(windows), batchSize],
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

  /**
   * Whether an object is still referenced by a job this run is not deleting.
   *
   * Phase 6 lets a failed attempt leave a staging object behind under its own cleanup
   * safeguard, and the published key of a completed job is the one thing that must not
   * be removed while the job row still points at it. This asks the question directly
   * rather than assuming the batch is the whole story.
   */
  async countJobsPointingAt(
    manager: EntityManager,
    objectKey: string,
    excludingJobId: string,
  ): Promise<number> {
    const rows: Array<{ total: number }> = await manager.query(
      'SELECT COUNT(*) AS total FROM export_jobs WHERE object_key = ? AND id <> ?',
      [objectKey, excludingJobId],
    );
    return Number(rows[0].total);
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
