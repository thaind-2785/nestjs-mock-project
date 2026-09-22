/**
 * What a ledger row says about one window of one task.
 *
 * There is no `PENDING`. A row exists because somebody claimed the window, so the
 * absence of a row is the absence of a run - which is what makes the insert an
 * election rather than a status update.
 */
export enum ScheduledRunStatus {
  /** Claimed and believed to be running. A row that stays here past its lease is a
   * run whose process died, and is recoverable. */
  Claimed = 'CLAIMED',
  Succeeded = 'SUCCEEDED',
  /** The attempt budget is spent. Deliberately terminal and deliberately loud: the
   * consequence of a silent retention failure is growth nobody is watching. */
  Failed = 'FAILED',
}
