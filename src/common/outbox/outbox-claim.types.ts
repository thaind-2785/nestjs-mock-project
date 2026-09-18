/**
 * Which event families a caller of the claim protocol owns.
 *
 * It is required rather than optional, and it reaches the SQL rather than a filter
 * applied afterwards. Two independent dispatchers now read one `outbox_events` table,
 * and a consumer that filtered after claiming would already hold the lease on the
 * other family's row: that row would then be invisible to its real owner until the
 * lease expired, which is a stall that looks exactly like a stuck worker.
 */
export type OutboxEventTypeAllowlist = readonly string[];

export interface OutboxClaim {
  id: string;
  attempt: number;
}

export interface OutboxClaimInput {
  eventTypes: OutboxEventTypeAllowlist;
  batchSize: number;
  leaseMs: number;
  claimToken: string;
}

export interface OutboxReleaseInput {
  eventTypes: OutboxEventTypeAllowlist;
  id: string;
  claimToken: string;
  attempt: number;
  retryInMs: number;
  errorCode: string;
}

export interface ClaimedRow {
  id: string;
  attempts: number;
}

export interface EligibleRow {
  id: string;
  availableAt: Date;
  createdAt: Date;
}
