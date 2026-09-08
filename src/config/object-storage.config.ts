import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

/**
 * Connection contract for the private S3-compatible bucket. It is deliberately
 * separate from any per-feature policy: the readiness probe, the attachment
 * storage adapter, and every later consumer must resolve the same endpoint,
 * bucket, and credentials from one place.
 */
export interface ObjectStorageConfiguration {
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export function createObjectStorageConfiguration(
  environment: EnvironmentVariables,
): ObjectStorageConfiguration {
  return {
    endpoint: environment.OBJECT_STORAGE_ENDPOINT,
    region: environment.OBJECT_STORAGE_REGION,
    forcePathStyle: environment.OBJECT_STORAGE_FORCE_PATH_STYLE,
    bucket: environment.OBJECT_STORAGE_BUCKET,
    accessKey: environment.OBJECT_STORAGE_ACCESS_KEY,
    secretKey: environment.OBJECT_STORAGE_SECRET_KEY,
  };
}

export const objectStorageConfig = registerAs('objectStorage', () =>
  createObjectStorageConfiguration(validateEnvironment(process.env)),
);
