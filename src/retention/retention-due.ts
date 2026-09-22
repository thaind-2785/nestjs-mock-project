import type { RetentionWindowConfiguration } from '../config/retention.config';
import { ExportJobStatus } from '../reports/entities/export-job.enums';
import { OutboxEventStatus } from '../common/outbox/outbox.enums';
import { notificationEventTypes } from '../notifications/notification-event';
import type { RetentionTaskName } from './retention.constants';

/**
 * What each task considers due, written once and used by both the report and, from
 * `P7-T03`, the deletion.
 *
 * One rule shapes every predicate below: it must be answerable from an index this
 * schema already has. A retention count runs against tables the API is serving reads
 * from, and a predicate the index cannot serve turns "how much is waiting" into a scan
 * of every row the system has ever written. Where honouring that meant anchoring on a
 * column other than the obvious one, the anchor is chosen so the window can only ever
 * be longer than specified, never shorter - retention is a minimum, and lagging is the
 * safe direction.
 *
 * `NOW(6)` is the only clock any of them reads.
 */
export interface RetentionDuePredicate {
  taskName: RetentionTaskName;
  table: string;
  /** Decides how old the oldest waiting row is - the reading that separates a busy
   * night from a task that is not running at all. */
  anchorColumn: string;
  where: string;
  parameters(windows: RetentionWindowConfiguration): unknown[];
  /**
   * How far behind the anchor the boundary sits, in hours.
   *
   * Reported separately so the backlog reading can be "how long has the oldest row been
   * overdue" rather than "how old is it". Without it, a healthy `notification-events`
   * always shows thirty days and looks identical to a task that stopped running a month
   * ago - which is precisely the distinction an operator is being asked to make. Zero
   * where the row carries its own boundary.
   */
  windowHours(windows: RetentionWindowConfiguration): number;
  /** The index this predicate is written against. `EXPLAIN` asserts it in the
   * integration suite, because an index chosen in a comment is a wish. */
  expectedIndex: string;
}

export const retentionDuePredicates: readonly RetentionDuePredicate[] = [
  {
    taskName: 'auth-sessions',
    table: 'auth_sessions',
    anchorColumn: 'refresh_expires_at',
    // A revoked session is collected on this same schedule rather than by a second
    // predicate on `revoked_at`, which has no index a global sweep could use. Since
    // revocation always precedes the refresh window's end, that is later than strictly
    // necessary and never earlier - and an expired session grants nothing either way.
    where: 'refresh_expires_at <= NOW(6) - INTERVAL ? HOUR',
    parameters: (windows) => [windows.sessionHours],
    windowHours: (windows) => windows.sessionHours,
    expectedIndex: 'idx_auth_sessions_refresh_expires',
  },
  {
    taskName: 'idempotency-keys',
    table: 'idempotency_keys',
    anchorColumn: 'expires_at',
    // No window parameter, deliberately. `expires_at` was written as "created plus
    // IDEMPOTENCY_RETENTION_HOURS" by the row's own author, so the promise SPEC-006
    // made is already in the row; re-deriving it here would be a second opinion about
    // a value that is not in question.
    where: 'expires_at <= NOW(6)',
    parameters: () => [],
    windowHours: () => 0,
    expectedIndex: 'idx_idempotency_keys_expires',
  },
  {
    taskName: 'storage-tasks',
    table: 'storage_cleanup_tasks',
    anchorColumn: 'available_at',
    // The same predicate `StorageCleanupService` claims with, so the count an operator
    // reads and the work the service will do describe one set of rows. An upload
    // safeguard before its `available_at` is still protecting an in-flight write.
    where:
      'available_at <= NOW(6) AND (lock_expires_at IS NULL OR lock_expires_at <= NOW(6))',
    parameters: () => [],
    windowHours: () => 0,
    expectedIndex: 'idx_storage_cleanup_tasks_claim',
  },
  {
    taskName: 'notification-events',
    table: 'outbox_events',
    anchorColumn: 'available_at',
    // Scoped to the notification family. The outbox is shared, and an export event's
    // row is owned by `export-results`, which deletes it together with the job that
    // `ON DELETE RESTRICT` ties it to. Without this filter the count would include
    // export events whose job is still `QUEUED` - rows that can never be deleted here,
    // reported as due forever, in the one number this slice exists to produce.
    //
    // Anchored on `available_at` rather than `processed_at` because there is no index
    // on `processed_at` at all. For a processed event `available_at <= processed_at` -
    // the event became available, then was processed - so this window is never shorter
    // than the one specified.
    //
    // Only PROCESSED is collected. A FAILED or PENDING event is the evidence behind a
    // redrive somebody may still need, and Phase 5's redrive command depends on it.
    where: `event_type IN (${notificationEventTypes.map(() => '?').join(', ')})
            AND status = ?
            AND available_at <= NOW(6) - INTERVAL ? HOUR`,
    parameters: (windows) => [
      ...notificationEventTypes,
      OutboxEventStatus.Processed,
      windows.notificationEventHours,
    ],
    // Leads on `event_type`, which is what makes a single-family sweep a range scan
    // rather than a filter over every event the system has ever written.
    windowHours: (windows) => windows.notificationEventHours,
    expectedIndex: 'idx_outbox_events_claim_by_type',
  },
  {
    taskName: 'export-results',
    table: 'export_jobs',
    anchorColumn: 'updated_at',
    // Terminal status is required rather than age alone: `expires_at` can be in the
    // past on a job that is still QUEUED or RUNNING, and deleting that would take a
    // job out from under the worker generating it.
    //
    // Anchored on `updated_at`, which for a terminal job is when it became terminal.
    // A failed job has no `expires_at` to anchor on, and `idx_export_jobs_operations`
    // leads on `(status, updated_at)`; the window already includes the result's own
    // lifetime, so a completed job is still collected a week after its result expired.
    where: 'status IN (?, ?) AND updated_at <= NOW(6) - INTERVAL ? HOUR',
    parameters: (windows) => [
      ExportJobStatus.Completed,
      ExportJobStatus.Failed,
      windows.exportTerminalHours,
    ],
    windowHours: (windows) => windows.exportTerminalHours,
    expectedIndex: 'idx_export_jobs_operations',
  },
];

export function retentionDuePredicate(
  taskName: RetentionTaskName,
): RetentionDuePredicate {
  const predicate = retentionDuePredicates.find(
    (candidate) => candidate.taskName === taskName,
  );
  if (!predicate) throw new Error(`No retention predicate for ${taskName}`);
  return predicate;
}
