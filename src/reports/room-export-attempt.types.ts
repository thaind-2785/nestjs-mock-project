export interface RoomExportAttemptClaim {
  jobId: string;
  /** The immutable snapshot stored at request time, never reread from a client. */
  filters: Record<string, unknown>;
}

interface RoomExportAttemptKey {
  outboxEventId: string;
  claimToken: string;
  attempt: number;
  jobId: string;
}

export interface RoomExportCompletion extends RoomExportAttemptKey {
  objectKey: string;
  rowCount: number;
  fileSizeBytes: number;
  contentSha256: string;
  resultTtlHours: number;
}

export interface RoomExportRetry extends RoomExportAttemptKey {
  retryInMs: number;
  errorCode: string;
}

export interface RoomExportFailureRecord extends RoomExportAttemptKey {
  errorCode: string;
}
