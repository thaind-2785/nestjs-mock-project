import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

export interface ReadinessConfiguration {
  timeoutMs: number;
  redis: {
    host: string;
    port: number;
  };
  storage: {
    endpoint?: string;
    region: string;
    forcePathStyle: boolean;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
}

export function createReadinessConfiguration(
  environment: EnvironmentVariables,
): ReadinessConfiguration {
  return {
    timeoutMs: environment.HEALTH_CHECK_TIMEOUT_MS,
    redis: {
      host: environment.REDIS_HOST,
      port: environment.REDIS_PORT,
    },
    storage: {
      endpoint: environment.OBJECT_STORAGE_ENDPOINT,
      region: environment.OBJECT_STORAGE_REGION,
      forcePathStyle: environment.OBJECT_STORAGE_FORCE_PATH_STYLE,
      bucket: environment.OBJECT_STORAGE_BUCKET,
      accessKey: environment.OBJECT_STORAGE_ACCESS_KEY,
      secretKey: environment.OBJECT_STORAGE_SECRET_KEY,
    },
  };
}

export const readinessConfig = registerAs('readiness', () =>
  createReadinessConfiguration(validateEnvironment(process.env)),
);
