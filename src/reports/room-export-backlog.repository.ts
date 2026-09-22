import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from '../common/outbox/outbox.enums';
import { StorageCleanupReason } from '../files/entities/attachment.enums';
import { roomExportEventTypes } from './room-export.constants';
import type {
  RoomExportBacklogSnapshot,
  RoomExportFailureGroup,
  RoomExportJobBacklog,
  RoomExportLeaseBacklog,
  RoomExportOutboxBacklog,
  RoomExportSafeguardBacklog,
} from './room-export-backlog.types';

/**
 * MySQL returns `COUNT(*)` and `TIMESTAMPDIFF` as BIGINT, which the driver hands back
 * as a string for every value rather than only large ones. Converting here keeps the
 * log from carrying `"3"` beside real numbers and breaking whatever alert compares
 * them.
 */
function toNumber(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

/** A group whose oldest row is not yet due reads as zero rather than as negative. */
function toAgeMs(value: string | number | null): number {
  return Math.max(0, Math.round(toNumber(value) / 1_000));
}

/**
 * What an operator alerts on, for exports only.
 *
 * Every statement is scoped to the export event family. The outbox is shared with
 * notifications, and an unscoped aggregate would let a stuck mail backlog drive the
 * export number and page the wrong on-call - which is the same reason the notification
 * sampler is scoped the other way.
 *
 * The five readings answer five different questions, and no one of them answers
 * another's: how much work is waiting, whether anything is stuck holding it, what the
 * durable jobs say, why the failed ones failed, and whether any upload was abandoned.
 * A pipeline can be healthy on four and broken on the fifth.
 */
@Injectable()
export class RoomExportBacklogRepository {
  async read(manager: EntityManager): Promise<RoomExportBacklogSnapshot> {
    // One read-only transaction, so every reading describes the same instant. Separate
    // autocommit statements can report a picture that never existed, which is exactly
    // the kind of thing an operator would chase.
    return manager.transaction('READ COMMITTED', async (transaction) => ({
      outbox: await this.readOutbox(transaction),
      leases: await this.readLeases(transaction),
      jobs: await this.readJobs(transaction),
      failures: await this.readFailures(transaction),
      safeguards: await this.readSafeguards(transaction),
    }));
  }

  private async readOutbox(
    manager: EntityManager,
  ): Promise<RoomExportOutboxBacklog[]> {
    const placeholders = roomExportEventTypes.map(() => '?').join(', ');
    // The age is computed by the database as the statement runs. Reading the timestamp
    // and subtracting it here would measure the age at the moment the row reached this
    // process, which under a slow query is not the age being alerted about.
    const rows: Array<{
      status: string;
      count: string;
      oldestAvailableAgeUs: string | null;
    }> = await manager.query(
      `SELECT status,
              COUNT(*) AS count,
              CASE WHEN status = ?
                   THEN TIMESTAMPDIFF(MICROSECOND, MIN(available_at), NOW(6))
                   ELSE 0 END AS oldestAvailableAgeUs
       FROM outbox_events
       WHERE event_type IN (${placeholders})
       GROUP BY status
       ORDER BY status ASC`,
      [OutboxEventStatus.Pending, ...roomExportEventTypes],
    );
    return rows.map((row) => ({
      status: row.status,
      count: toNumber(row.count),
      oldestAvailableAgeMs: toAgeMs(row.oldestAvailableAgeUs),
    }));
  }

  /**
   * Live and expired leases separately, because they mean opposite things. A live lease
   * is work in progress; an expired one is work whose worker stopped and which nothing
   * has recovered yet. A single "claimed" count would hide the difference, and the
   * difference is the whole signal.
   */
  private async readLeases(
    manager: EntityManager,
  ): Promise<RoomExportLeaseBacklog> {
    const placeholders = roomExportEventTypes.map(() => '?').join(', ');
    const rows: Array<{
      liveCount: string;
      expiredCount: string;
      oldestExpiredAgeUs: string | null;
    }> = await manager.query(
      `SELECT SUM(lock_expires_at > NOW(6)) AS liveCount,
              SUM(lock_expires_at <= NOW(6)) AS expiredCount,
              TIMESTAMPDIFF(
                MICROSECOND,
                MIN(CASE WHEN lock_expires_at <= NOW(6) THEN lock_expires_at END),
                NOW(6)
              ) AS oldestExpiredAgeUs
       FROM outbox_events
       WHERE status = ?
         AND event_type IN (${placeholders})`,
      [OutboxEventStatus.Processing, ...roomExportEventTypes],
    );
    const row = rows[0];
    return {
      liveCount: toNumber(row?.liveCount ?? 0),
      expiredCount: toNumber(row?.expiredCount ?? 0),
      oldestExpiredAgeMs: toAgeMs(row?.oldestExpiredAgeUs ?? null),
    };
  }

  private async readJobs(
    manager: EntityManager,
  ): Promise<RoomExportJobBacklog[]> {
    // Deliberately lifetime counts. A time window would make a number fall because the
    // clock crossed a boundary rather than because anything happened, and the bound on
    // this table is Phase 7 retention rather than a `WHERE`.
    const rows: Array<{ status: string; count: string }> = await manager.query(
      `SELECT status, COUNT(*) AS count
       FROM export_jobs
       GROUP BY status
       ORDER BY status ASC`,
    );
    return rows.map((row) => ({
      status: row.status as RoomExportJobBacklog['status'],
      count: toNumber(row.count),
    }));
  }

  /**
   * Failures grouped by their stable code, which is what makes the sample actionable:
   * twenty `EXPORT_ROW_LIMIT_EXCEEDED` is administrators filtering too broadly, and
   * twenty `EXPORT_STORAGE_UNAVAILABLE` is an outage. The count alone cannot tell them
   * apart, and the codes are the only thing here safe to publish.
   */
  private async readFailures(
    manager: EntityManager,
  ): Promise<RoomExportFailureGroup[]> {
    const rows: Array<{ errorCode: string | null; count: string }> =
      await manager.query(
        `SELECT last_error_code AS errorCode, COUNT(*) AS count
         FROM export_jobs
         WHERE last_error_code IS NOT NULL
         GROUP BY last_error_code
         ORDER BY count DESC, last_error_code ASC`,
      );
    return rows.map((row) => ({
      errorCode: row.errorCode ?? 'UNKNOWN',
      count: toNumber(row.count),
    }));
  }

  /**
   * Safeguards past their due time: each one is an uploaded object no job points at,
   * waiting for the cleanup runner. A number that grows rather than drains means either
   * attempts are dying after upload or cleanup is not running - and until Phase 7 adds
   * the schedule, the second is the normal state, which is why this is reported rather
   * than alerted on.
   */
  private async readSafeguards(
    manager: EntityManager,
  ): Promise<RoomExportSafeguardBacklog> {
    const rows: Array<{
      dueCount: string;
      oldestDueAgeUs: string | null;
    }> = await manager.query(
      `SELECT COUNT(*) AS dueCount,
              TIMESTAMPDIFF(MICROSECOND, MIN(available_at), NOW(6)) AS oldestDueAgeUs
       FROM storage_cleanup_tasks
       WHERE reason = ?
         AND available_at <= NOW(6)
         AND object_key LIKE ?`,
      [StorageCleanupReason.UploadSafeguard, 'exports/rooms/%'],
    );
    const row = rows[0];
    return {
      dueCount: toNumber(row?.dueCount ?? 0),
      oldestDueAgeMs: toAgeMs(row?.oldestDueAgeUs ?? null),
    };
  }
}
