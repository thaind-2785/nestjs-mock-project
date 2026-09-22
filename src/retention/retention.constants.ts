/**
 * The five tasks, named once.
 *
 * These strings are stored in `scheduled_runs.task_name` and are therefore part of the
 * ledger's durable shape: renaming one would orphan its history and let the renamed
 * task claim a window the old name already ran. They are identifiers, not labels, and
 * nothing user-facing reads them.
 */
export const retentionTaskNames = [
  'auth-sessions',
  'idempotency-keys',
  'storage-tasks',
  'notification-events',
  'export-results',
] as const;

export type RetentionTaskName = (typeof retentionTaskNames)[number];

/** The stable codes a failed run records. Never a provider message, never SQL. */
export const retentionErrorCodes = {
  /** The task threw something the classifier does not recognise. Retryable, because
   * "unclassified" is a statement about our knowledge, not about the database. */
  taskFailed: 'RETENTION_TASK_FAILED',
  /** A bounded statement exceeded its timeout. */
  statementTimeout: 'RETENTION_STATEMENT_TIMEOUT',
  /** The object store refused a delete. The metadata is kept and stays due. */
  storageUnavailable: 'RETENTION_STORAGE_UNAVAILABLE',
  /** The claim was gone by the time the run tried to finish. Not an error to retry:
   * whoever recovered it owns the window now. */
  claimLost: 'RETENTION_CLAIM_LOST',
  /** A claimed run's lease expired with its attempt budget already spent, so its
   * process died and nobody may pick the window up again. Recorded by whichever
   * replica noticed, because the run that died could not record anything. */
  runAbandoned: 'RETENTION_RUN_ABANDONED',
} as const;

export type RetentionErrorCode =
  (typeof retentionErrorCodes)[keyof typeof retentionErrorCodes];

/** Longest `task_name` the column accepts. Asserted against the list above rather than
 * trusted: a longer name would be refused at insert, and the window would never run. */
export const maxTaskNameLength = 64;

/** Longest stable error code the column accepts, asserted the same way. */
export const maxErrorCodeLength = 64;

/** MySQL's `INTERVAL ... MICROSECOND` is the finest unit that takes a bound parameter,
 * so every millisecond bound is converted on its way into a statement. */
export const microsecondsPerMillisecond = 1_000;

/** Windows are configured in hours and read back as milliseconds. */
export const millisecondsPerHour = 3_600_000;
