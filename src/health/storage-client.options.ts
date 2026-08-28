import type { S3ClientConfig } from '@aws-sdk/client-s3';
import type { ReadinessConfiguration } from '../config/readiness.config';

export function createStorageClientOptions(
  storage: ReadinessConfiguration['storage'],
): S3ClientConfig {
  return {
    ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
    region: storage.region,
    forcePathStyle: storage.forcePathStyle,
    credentials: {
      accessKeyId: storage.accessKey,
      secretAccessKey: storage.secretKey,
    },
  };
}
