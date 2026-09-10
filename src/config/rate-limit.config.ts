import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';
import {
  createRedisConnectionConfiguration,
  RedisConnectionConfiguration,
} from './redis.config';

export interface RateLimitConfiguration {
  redisKeyPrefix: string;
  connection: RedisConnectionConfiguration;
}

export function createRateLimitConfiguration(
  environment: EnvironmentVariables,
): RateLimitConfiguration {
  return {
    redisKeyPrefix: environment.RATE_LIMIT_REDIS_KEY_PREFIX,
    connection: createRedisConnectionConfiguration(environment),
  };
}

export const rateLimitConfig = registerAs('rateLimit', () =>
  createRateLimitConfiguration(validateEnvironment(process.env)),
);
