import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import Redis from 'ioredis';
import { TerminusModule } from '@nestjs/terminus';
import { readinessConfig } from '../config/readiness.config';
import { HealthController } from './health.controller';
import {
  READINESS_REDIS_FACTORY,
  READINESS_STORAGE_CLIENT,
} from './readiness.tokens';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [ConfigModule.forFeature(readinessConfig), TerminusModule],
  controllers: [HealthController],
  providers: [
    ReadinessService,
    {
      provide: READINESS_REDIS_FACTORY,
      inject: [readinessConfig.KEY],
      useFactory: (configuration: ConfigType<typeof readinessConfig>) => () =>
        new Redis({
          host: configuration.redis.host,
          port: configuration.redis.port,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: configuration.timeoutMs,
          retryStrategy: () => null,
        }),
    },
    {
      provide: READINESS_STORAGE_CLIENT,
      inject: [readinessConfig.KEY],
      useFactory: (configuration: ConfigType<typeof readinessConfig>) =>
        new S3Client({
          endpoint: configuration.storage.endpoint,
          region: 'us-east-1',
          forcePathStyle: true,
          credentials: {
            accessKeyId: configuration.storage.accessKey,
            secretAccessKey: configuration.storage.secretKey,
          },
        }),
    },
  ],
})
export class HealthModule {}
