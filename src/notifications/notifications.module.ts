import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { OutboxEvent } from '../bookings/entities/outbox-event.entity';
import { reportRedisClientErrors } from '../common/redis/redis-client-errors';
import { notificationsConfig } from '../config/notifications.config';
import { DatabaseModule } from '../database/database.module';
import { EmailDelivery } from './entities/email-delivery.entity';
import { DeliveryPreparationService } from './delivery-preparation.service';
import { EmailTemplateService } from './email-template.service';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_QUEUE_CLIENT,
} from './notification.tokens';
import { OutboxClaimRepository } from './outbox-claim.repository';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

/**
 * The notification boundary owns validated delivery configuration, the P5-T03
 * provider-independent preparation path, and the P5-T04 outbox relay. The SMTP
 * adapters (`P5-T05`) are registered here as that slice lands, so the worker context
 * keeps importing one module rather than growing a second wiring path.
 *
 * Importing this module starts the relay polling, which is also what holds the
 * worker process open.
 *
 * It is deliberately absent from `AppModule`: importing the API must never create an
 * SMTP transport or start consuming a queue.
 */
@Module({
  imports: [
    ConfigModule.forFeature(notificationsConfig),
    DatabaseModule,
    // The worker reads the outbox the booking module writes, and owns the delivery
    // record. Registering both here keeps the worker context independent of the API
    // module graph rather than borrowing the bookings registration.
    TypeOrmModule.forFeature([OutboxEvent, EmailDelivery]),
  ],
  providers: [
    EmailTemplateService,
    DeliveryPreparationService,
    OutboxClaimRepository,
    OutboxDispatcherService,
    {
      provide: NOTIFICATION_QUEUE_CLIENT,
      inject: [notificationsConfig.KEY],
      useFactory: (configuration: ConfigType<typeof notificationsConfig>) => {
        const { connection } = configuration.queue;
        const client = new Redis({
          host: connection.host,
          port: connection.port,
          lazyConnect: true,
          // A producer that cannot reach Redis must say so immediately: the claim is
          // already committed and the dispatcher hands it back with a retry time
          // rather than buffering commands for a server that may never answer.
          enableOfflineQueue: false,
          // BullMQ requires an unbounded per-request retry budget for its blocking
          // commands; the connect and command timeouts still bound every wait.
          maxRetriesPerRequest: null,
          connectTimeout: connection.timeoutMs,
          commandTimeout: connection.timeoutMs,
        });
        reportRedisClientErrors(client, 'notification-queue');
        return client;
      },
    },
    {
      provide: NOTIFICATION_QUEUE,
      inject: [notificationsConfig.KEY, NOTIFICATION_QUEUE_CLIENT],
      useFactory: (
        configuration: ConfigType<typeof notificationsConfig>,
        client: Redis,
      ) =>
        new Queue(configuration.queue.name, {
          connection: client,
          prefix: configuration.queue.prefix,
        }),
    },
  ],
  exports: [
    ConfigModule,
    TypeOrmModule,
    EmailTemplateService,
    DeliveryPreparationService,
    OutboxClaimRepository,
    OutboxDispatcherService,
  ],
})
export class NotificationsModule {}
