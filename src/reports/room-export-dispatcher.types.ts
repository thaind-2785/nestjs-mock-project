/** Everything the queue carries. No filters, no requester, no object key. */
export interface RoomExportJobData {
  outboxEventId: string;
  claimToken: string;
  attempt: number;
}

export interface RoomExportDispatchResult {
  claimed: number;
  queued: number;
  released: number;
}
