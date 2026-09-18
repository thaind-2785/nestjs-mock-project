export interface RoomExportAttemptOutcome {
  result: 'completed' | 'retried' | 'failed' | 'skipped';
  errorCode?: string;
}
