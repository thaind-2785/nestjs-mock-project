/**
 * The durable lifecycle of one outbox event, shared by every family that uses the
 * table.
 *
 * `FAILED` is terminal and keeps no lease, so a permanently failed event cannot look
 * like work somebody still owns.
 */
export enum OutboxEventStatus {
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Processed = 'PROCESSED',
  Failed = 'FAILED',
}
