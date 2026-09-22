import type {
  RetentionErrorCode,
  RetentionTaskName,
} from './retention.constants';

/** A window this replica owns, and the token every later write must carry. */
export interface ScheduledRunClaim {
  id: string;
  taskName: RetentionTaskName;
  scheduledFor: Date;
  claimToken: string;
  attempt: number;
}

/** Why a claim attempt produced nothing. Distinguished because only one of them is
 * unusual: losing an election is the normal outcome for every replica but one. */
export type ScheduledRunClaimRefusal =
  /** Somebody else holds this window, or it has already finished. */
  | 'taken'
  /** The window is recorded `FAILED`; its attempt budget is spent and an operator
   * owns it now. */
  | 'exhausted';

export type ScheduledRunClaimResult =
  | { outcome: 'claimed'; claim: ScheduledRunClaim }
  | { outcome: 'refused'; reason: ScheduledRunClaimRefusal };

export interface ScheduledRunFailure {
  errorCode: RetentionErrorCode;
  /** Whether the budget allows another replica to pick this window up again. */
  retryable: boolean;
}
