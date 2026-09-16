/**
 * Everything the worker needs to find its work again, and nothing else. The event
 * payload, recipient, and rendered body stay in MySQL: Redis holds opaque identifiers
 * so a queue dump cannot disclose who was emailed about what.
 */
export interface NotificationJobData {
  outboxEventId: string;
  claimToken: string;
  attempt: number;
}

export interface DispatchResult {
  claimed: number;
  queued: number;
  released: number;
}
