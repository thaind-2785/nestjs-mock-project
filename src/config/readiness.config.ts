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
    endpoint: string;
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
      endpoint: environment.MINIO_ENDPOINT,
      bucket: environment.MINIO_BUCKET,
      accessKey: environment.MINIO_ACCESS_KEY,
      secretKey: environment.MINIO_SECRET_KEY,
    },
  };
}

export const readinessConfig = registerAs('readiness', () =>
  createReadinessConfiguration(validateEnvironment(process.env)),
);
