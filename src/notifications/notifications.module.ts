import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { reportRedisClientErrors } from '../common/redis/redis-client-errors';
import { notificationsConfig } from '../config/notifications.config';
import { DatabaseModule } from '../database/database.module';
import { EmailDelivery } from './entities/email-delivery.entity';
import { DeliveryPreparationService } from './delivery-preparation.service';
import { EmailTemplateService } from './email-template.service';
import { DeliveryResultRepository } from './delivery-result.repository';
import { DeliveryWorkerService } from './delivery-worker.service';
import { EMAIL_SENDER } from './email-sender';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_QUEUE_CLIENT,
  NOTIFICATION_WORKER_CLIENT,
} from './notification.tokens';
import { NotificationBacklogRepository } from './notification-backlog.repository';
import { NotificationBacklogService } from './notification-backlog.service';
import { SendAttemptRepository } from './send-attempt.repository';
import { SmtpEmailSender } from './smtp-email-sender';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

/**
 * The whole notification boundary: validated configuration, the provider-independent
 * preparation path, the outbox relay, and the SMTP adapter behind one port.
 *
 * Importing this module starts the relay polling and the delivery consumer, which is
 * also what holds the worker process open. It is deliberately absent from
 * `AppModule`: importing the API must never create an SMTP transport or consume a
 * queue.
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
    DeliveryResultRepository,
    DeliveryWorkerService,
    NotificationBacklogRepository,
    NotificationBacklogService,
    SendAttemptRepository,
    { provide: EMAIL_SENDER, useClass: SmtpEmailSender },
    {
      provide: NOTIFICATION_QUEUE_CLIENT,
      inject: [notificationsConfig.KEY],
      useFactory: (configuration: ConfigType<typeof notificationsConfig>) => {
        const { connection } = configuration.queue;
        const client = new Redis({
          host: connection.host,
          port: connection.port,
          password: connection.password,
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
      // The consumer needs a connection of its own: BullMQ workers hold a blocking
      // command open, which would stall every producer command sharing the socket.
      provide: NOTIFICATION_WORKER_CLIENT,
      inject: [notificationsConfig.KEY],
      useFactory: (configuration: ConfigType<typeof notificationsConfig>) => {
        const { connection } = configuration.queue;
        const client = new Redis({
          host: connection.host,
          port: connection.port,
          password: connection.password,
          lazyConnect: true,
          maxRetriesPerRequest: null,
          connectTimeout: connection.timeoutMs,
        });
        reportRedisClientErrors(client, 'notification-worker');
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
    DeliveryResultRepository,
    DeliveryWorkerService,
    NotificationBacklogRepository,
    NotificationBacklogService,
    SendAttemptRepository,
    EMAIL_SENDER,
  ],
})
export class NotificationsModule {}
