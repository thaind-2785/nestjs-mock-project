import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';
import {
  createRedisConnectionConfiguration,
  RedisConnectionConfiguration,
} from './redis.config';
import {
  createObjectStorageConfiguration,
  ObjectStorageConfiguration,
} from './object-storage.config';

export interface ReadinessConfiguration {
  timeoutMs: number;
  redis: RedisConnectionConfiguration;
  /** The probe writes here, so it proves the namespace the limiter actually uses. */
  rateLimitKeyPrefix: string;
  // The probe must target the bucket the application actually writes to, so the
  // connection contract is reused instead of re-read from the environment here.
  storage: ObjectStorageConfiguration;
}

export function createReadinessConfiguration(
  environment: EnvironmentVariables,
): ReadinessConfiguration {
  return {
    timeoutMs: environment.HEALTH_CHECK_TIMEOUT_MS,
    // The shared contract rather than two fields read again here: the probe must reach
    // the same server, with the same credential, as the code paths it stands in for.
    redis: createRedisConnectionConfiguration(environment),
    rateLimitKeyPrefix: environment.RATE_LIMIT_REDIS_KEY_PREFIX,
    storage: createObjectStorageConfiguration(environment),
  };
}

export const readinessConfig = registerAs('readiness', () =>
  createReadinessConfiguration(validateEnvironment(process.env)),
);
