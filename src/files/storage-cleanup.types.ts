export interface StorageCleanupOptions {
  batchSize?: number;
  workerId?: string;
}

export interface StorageCleanupResult {
  claimed: number;
  deleted: number;
  retryable: number;
}
