/**
 * The durable lifecycle of one export job.
 *
 * `EXPIRED` is deliberately absent. It is a read-time view of a completed result whose
 * `expires_at` has passed, not a stored state: writing it would need a scheduler that
 * Phase 6 does not have, and a result that is only expired once something remembered
 * to say so is a result the API would still hand out in the meantime.
 */
export enum ExportJobStatus {
  Queued = 'QUEUED',
  Processing = 'PROCESSING',
  Completed = 'COMPLETED',
  Failed = 'FAILED',
}
