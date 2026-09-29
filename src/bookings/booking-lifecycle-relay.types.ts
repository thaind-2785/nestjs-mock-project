/** One claimed row as the relay reads it back: nothing the publish does not use. */
export interface ClaimedLifecycleRow {
  id: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * A publishable message, independent of the Kafka client. The adapter maps it to the
 * client's own type, so the relay and its tests never import `kafkajs`.
 */
export interface BookingLifecycleMessage {
  key: string;
  value: string;
  timestampMs: number;
  headers: Record<string, string>;
}

export interface LifecycleFinalizeInput {
  ids: readonly string[];
  claimToken: string;
}

export interface LifecycleRetryInput extends LifecycleFinalizeInput {
  backoffInitialMs: number;
  backoffMaxMs: number;
  errorCode: string;
}

export interface LifecycleFailInput extends LifecycleFinalizeInput {
  errorCode: string;
}

export interface BookingLifecycleRelayResult {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
}
