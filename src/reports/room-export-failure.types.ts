export interface RoomExportFailure {
  /** Stable, content-free, and the only part an administrator ever sees. */
  errorCode: string;
  retryable: boolean;
  /** Server-side diagnosis only; never stored on the job and never returned. */
  cause: unknown;
}
