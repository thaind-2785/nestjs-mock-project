import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from '../bookings/entities/booking.enums';
import type {
  DeliveryBacklogEntry,
  DeliveryBacklogRow,
  LeaseBacklog,
  LeaseBacklogRow,
  NotificationBacklogSnapshot,
  OutboxBacklogEntry,
  OutboxBacklogRow,
} from './notification-backlog.types';
import { notificationEventTypes } from './notification-event';

/**
 * MySQL returns `COUNT(*)` and `TIMESTAMPDIFF` as BIGINT, which the driver hands back
 * as a string - for every value, not only large ones. Converting here keeps the log
 * from carrying `"3"` beside real numbers and breaking whatever alert compares them.
 */
function toNumber(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * A group whose oldest row is not yet due gives a negative difference. Reporting it as
 * zero keeps "nothing is overdue" distinct from "overdue by a negative amount", which
 * no alert threshold reads correctly.
 */
function toAgeMs(value: string | number | null): number {
  return Math.max(0, Math.round(toNumber(value) / 1_000));
}

/**
 * Aggregate state of the delivery pipeline, for alerting rather than for decisions.
 *
 * Every statement is scoped to the event types this worker actually delivers. The
 * outbox is shared with the export events Phase 6 adds, and an unscoped aggregate
 * would let a stuck export drive the notification backlog number and page the wrong
 * on-call.
 *
 * The outbox aggregate groups over the whole table and cannot use the claim index,
 * which covers `(status, available_at, lock_expires_at)` and not `event_type`. That is
 * deliberate: the alternative is an index every booking transition must maintain on
 * the hottest write path in the system, to serve a read that runs once per
 * `NOTIFICATION_BACKLOG_SAMPLE_INTERVAL_MS`. Measured at 200k rows it is ~80ms, so the
 * interval is floored at five seconds and the sampler never runs inside a claim or a
 * delivery transaction. The expired-lease statement is the exception: its predicate
 * matches the claim index exactly, which is why stuck leases can be sampled cheaply.
 *
 * Statuses sort in lifecycle order rather than alphabetically, because MySQL sorts an
 * `ENUM` by its declared position. A sample therefore reads pending-before-terminal,
 * which is the order an operator scans it in.
 */
@Injectable()
export class NotificationBacklogRepository {
  async read(manager: EntityManager): Promise<NotificationBacklogSnapshot> {
    // One read-only transaction, so the outbox half and the delivery half describe
    // the same instant. Two autocommit statements can report a pair of pictures that
    // never coexisted, which is exactly the kind of thing an operator would chase.
    return manager.transaction('READ COMMITTED', async (transaction) => ({
      outbox: await this.readOutbox(transaction),
      leases: await this.readExpiredLeases(transaction),
      deliveries: await this.readDeliveries(transaction),
    }));
  }

  private async readOutbox(
    manager: EntityManager,
  ): Promise<OutboxBacklogEntry[]> {
    const placeholders = notificationEventTypes.map(() => '?').join(', ');
    // The age is computed by the database as the statement runs. Reading the timestamp
    // and subtracting it in Node would measure the age at the moment the row reached
    // this process, which under a slow query is not the age being alerted about.
    //
    // `CASE` restricts it to PENDING in SQL rather than in the mapper, so a terminal
    // group costs nothing and reports nothing.
    const rows: OutboxBacklogRow[] = await manager.query(
      `SELECT event_type AS eventType,
              status,
              COUNT(*) AS count,
              CASE WHEN status = ?
                   THEN TIMESTAMPDIFF(MICROSECOND, MIN(available_at), NOW(6))
                   ELSE 0 END AS oldestAvailableAgeUs
       FROM outbox_events
       WHERE event_type IN (${placeholders})
       GROUP BY event_type, status
       ORDER BY event_type ASC, status ASC`,
      [OutboxEventStatus.Pending, ...notificationEventTypes],
    );
    return rows.map((row) => ({
      eventType: row.eventType,
      status: row.status,
      count: toNumber(row.count),
      oldestAvailableAgeMs: toAgeMs(row.oldestAvailableAgeUs),
    }));
  }

  /**
   * Uses `idx_outbox_events_claim` directly: `status` equality then a range on
   * `lock_expires_at`. This is the signal the pending backlog cannot give, because a
   * claimed event is absent from it whether or not anything is still working on it.
   */
  private async readExpiredLeases(
    manager: EntityManager,
  ): Promise<LeaseBacklog> {
    const placeholders = notificationEventTypes.map(() => '?').join(', ');
    const rows: LeaseBacklogRow[] = await manager.query(
      `SELECT COUNT(*) AS expiredCount,
              TIMESTAMPDIFF(MICROSECOND, MIN(lock_expires_at), NOW(6)) AS oldestExpiredAgeUs
       FROM outbox_events
       WHERE status = ?
         AND lock_expires_at <= NOW(6)
         AND event_type IN (${placeholders})`,
      [OutboxEventStatus.Processing, ...notificationEventTypes],
    );
    const row = rows[0];
    return {
      expiredCount: toNumber(row?.expiredCount ?? 0),
      oldestExpiredAgeMs: toAgeMs(row?.oldestExpiredAgeUs ?? null),
    };
  }

  private async readDeliveries(
    manager: EntityManager,
  ): Promise<DeliveryBacklogEntry[]> {
    // These are deliberately lifetime counts: omitting SENT would hide throughput,
    // and a time WHERE would make a count fall merely because the clock crossed a
    // boundary, so the WHERE that would bound this scan is the one that would break
    // the metric. The bound is an access path instead:
    // `idx_email_deliveries_template_status` leads on the grouping columns in the
    // order asked for here and carries nothing else, so this is a covering index scan
    // with no row lookups and no sort. Keep the SELECT list, GROUP BY, and ORDER BY
    // aligned with that index; adding a column here silently returns it to a
    // clustered-index scan. Row growth itself is bounded by Phase 7 retention.
    const rows: DeliveryBacklogRow[] = await manager.query(
      `SELECT template_key AS templateKey,
              status,
              COUNT(*) AS count
       FROM email_deliveries
       GROUP BY template_key, status
       ORDER BY template_key ASC, status ASC`,
    );
    return rows.map((row) => ({
      templateKey: row.templateKey,
      status: row.status,
      count: toNumber(row.count),
    }));
  }
}
