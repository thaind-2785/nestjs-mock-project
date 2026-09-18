export interface RoomExportUpload {
  objectKey: string;
  body: Buffer;
  /** Hex digest, stored on the job and sent to the provider for verification. */
  contentSha256: string;
}
