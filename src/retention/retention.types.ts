import type { RetentionTaskName } from './retention.constants';

/** One task's answer to "how much is waiting, and for how long". */
export interface RetentionDueSample {
  dueCount: number;
  /**
   * How long the oldest waiting row has been past its boundary, not how old it is.
   *
   * Zero when nothing is due, and near zero on a healthy task whatever its window.
   * Measured from the database clock.
   */
  oldestOverdueMs: number;
}

/** What the operator command prints, one line per task. */
export interface RetentionTaskReport extends RetentionDueSample {
  taskName: RetentionTaskName;
  table: string;
  /** Printed beside the reading, so "overdue by an hour" can be read against the
   * window it is overdue on. Zero where the row carries its own boundary. */
  windowHours: number;
}

/** What one bounded pass of one task did, and whether the run should ask again. */
export interface RetentionBatchOutcome {
  /**
   * Rows removed, per table.
   *
   * `export_objects` is the one key that is not a table: objects live in the store
   * rather than the database, and an operator reading the ledger needs to know how many
   * were removed, not only how many rows stopped pointing at them.
   */
  counts: Record<string, number>;
  moreWaiting: boolean;
  /** Rows left behind because a provider refused. They stay due; nothing failed. */
  retryableFailures?: number;
}

/** What a whole run did to one window. */
export interface RetentionRunOutcome {
  taskName: RetentionTaskName;
  /**
   * `incomplete` is its own outcome, not a flavour of success.
   *
   * A run that spent its budget or was refused rows by a provider did real work and did
   * not finish. Recording it as completed would clear the lease, and the window key
   * would then refuse every further claim that day - so the remainder would not be due
   * tomorrow, it would be due forever.
   */
  outcome: 'completed' | 'incomplete' | 'refused' | 'failed';
  /** Why, when the window was not this replica's to run. */
  reason?: 'taken' | 'exhausted';
  counts: Record<string, number>;
  batches: number;
  /** True when the budget stopped the run with work still waiting. */
  budgetSpent: boolean;
  /** Rows a provider refused. Nonzero means the window was handed back. */
  retryableFailures?: number;
  errorCode?: string;
}

/** The parent rows one chain batch will work through. */
export interface RetentionEventBatch {
  eventIds: string[];
}

export interface RetentionExportBatch {
  jobs: Array<{ id: string; objectKey: string | null; outboxEventId: string }>;
}

/** One task's line in a backlog sample. */
export interface RetentionBacklogTask {
  taskName: RetentionTaskName;
  table: string;
  windowHours: number;
  due: number;
  oldestOverdueMs: number;
}
