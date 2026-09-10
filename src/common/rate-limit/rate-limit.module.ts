import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { rateLimitConfig } from '../../config/rate-limit.config';
import { reportRedisClientErrors } from '../redis/redis-client-errors';
import { RateLimitService } from './rate-limit.service';
import { RATE_LIMIT_REDIS_CLIENT } from './rate-limit.tokens';

/**
 * One limiter for every request budget in the application. It owns its own Redis
 * client and namespace on purpose: a limiter shared by authentication and uploads
 * must not depend on the auth module's connection, key prefix, or lifecycle.
 */
@Module({
  imports: [ConfigModule.forFeature(rateLimitConfig)],
  providers: [
    RateLimitService,
    {
      provide: RATE_LIMIT_REDIS_CLIENT,
      inject: [rateLimitConfig.KEY],
      useFactory: (configuration: ConfigType<typeof rateLimitConfig>) => {
        const client = new Redis({
          host: configuration.connection.host,
          port: configuration.connection.port,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: configuration.connection.timeoutMs,
          // A reachable but stalled server (loading an RDB after failover) must not
          // hold a fail-closed caller open, so the command and the readiness wait
          // are bounded too, not only the TCP handshake.
          commandTimeout: configuration.connection.timeoutMs,
          maxLoadingRetryTime: configuration.connection.timeoutMs,
          retryStrategy: () => null,
        });
        reportRedisClientErrors(client, 'rate-limit');
        return client;
      },
    },
  ],
  exports: [RateLimitService],
})
export class RateLimitModule {}
