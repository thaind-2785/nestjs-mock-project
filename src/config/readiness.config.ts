import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';
import {
  createObjectStorageConfiguration,
  ObjectStorageConfiguration,
} from './object-storage.config';

export interface ReadinessConfiguration {
  timeoutMs: number;
  redis: {
    host: string;
    port: number;
  };
  // The probe must target the bucket the application actually writes to, so the
  // connection contract is reused instead of re-read from the environment here.
  storage: ObjectStorageConfiguration;
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
    storage: createObjectStorageConfiguration(environment),
  };
}

export const readinessConfig = registerAs('readiness', () =>
  createReadinessConfiguration(validateEnvironment(process.env)),
);
