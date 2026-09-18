export interface IdempotencyLockInput {
  actorUserId: string;
  /** The operation namespace, a literal per endpoint. Never caller text. */
  operation: string;
  idempotencyKey: string;
  /** A canonical digest of the request this key is allowed to replay. */
  fingerprint: string;
}

export interface IdempotencyCompletion {
  responseStatus: number;
  responseBody: Record<string, unknown>;
}
