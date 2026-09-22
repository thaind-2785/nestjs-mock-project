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
