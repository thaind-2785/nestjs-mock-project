export interface OutboxClaim {
  id: string;
  attempt: number;
}

export interface OutboxClaimInput {
  batchSize: number;
  leaseMs: number;
  claimToken: string;
}

export interface OutboxReleaseInput {
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
