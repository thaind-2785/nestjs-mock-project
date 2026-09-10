import type { S3ClientConfig } from '@aws-sdk/client-s3';
import type { ObjectStorageConfiguration } from '../../config/object-storage.config';

/**
 * One client-options builder for every S3-compatible consumer, so the readiness
 * probe and the attachment adapter cannot disagree about endpoint style,
 * region, or credentials.
 */
export function createObjectStorageClientOptions(
  storage: ObjectStorageConfiguration,
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
