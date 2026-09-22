import type { RetentionTaskName } from './retention.constants';

/** One task's answer to "how much is waiting, and for how long". */
export interface RetentionDueSample {
  dueCount: number;
  /** Zero when nothing is due. Milliseconds, from the database clock. */
  oldestDueAgeMs: number;
}

/** What the operator command prints, one line per task. */
export interface RetentionTaskReport extends RetentionDueSample {
  taskName: RetentionTaskName;
  table: string;
}
