/**
 * Whether a claimed key has a stored response yet.
 *
 * `PENDING` means one caller holds the row and is doing the work; `COMPLETED` means the
 * response is stored and every later caller with the same key replays it.
 */
export enum IdempotencyKeyStatus {
  Pending = 'PENDING',
  Completed = 'COMPLETED',
}
