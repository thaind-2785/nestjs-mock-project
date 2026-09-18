export interface ObjectStorageUpload {
  objectKey: string;
  body: Buffer;
  contentType: string;
  /** Bounds this call. Different callers upload different sizes over the same client. */
  timeoutMs: number;
  /**
   * Base64 SHA-256 the provider verifies against what it received. An upload that
   * arrives corrupted is refused rather than stored under a key metadata points at.
   */
  checksumSha256?: string;
}

export interface ObjectStorageDelete {
  objectKey: string;
  timeoutMs: number;
}

export interface ObjectStoragePresign {
  objectKey: string;
  ttlSeconds: number;
  /**
   * The filename a browser saves. Absent for attachments, which are displayed rather
   * than downloaded; present for an export, whose name carries its job.
   */
  downloadFilename?: string;
  contentType?: string;
}
