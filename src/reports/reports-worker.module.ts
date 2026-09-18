import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { reportRedisClientErrors } from '../common/redis/redis-client-errors';
import { reportsConfig } from '../config/reports.config';
import { DatabaseModule } from '../database/database.module';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import { ObjectStorageModule } from '../common/storage/object-storage.module';
import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { ExportJob } from './entities/export-job.entity';
import { RoomExportAttemptRepository } from './room-export-attempt.repository';
import { RoomExportConsumerService } from './room-export-consumer.service';
import { RoomExportDispatcherService } from './room-export-dispatcher.service';
import { RoomExportGeneratorService } from './room-export-generator.service';
import { RoomExportStorageService } from './room-export-storage.service';
import { RoomExportSnapshotRepository } from './room-export-snapshot.repository';
import { RoomExportQueueLifecycle } from './room-export-queue.lifecycle';
import {
  ROOM_EXPORT_QUEUE,
  ROOM_EXPORT_QUEUE_CLIENT,
  ROOM_EXPORT_WORKER_CLIENT,
} from './report.tokens';

/**
 * The worker half of the export boundary: a dedicated queue and its own Redis
 * connections, with the dispatcher, consumer, and Worker Thread arriving in the
 * slices that follow.
 *
 * The queue is the export family's alone. Sharing the notification queue would let a
 * mail backlog spend the concurrency of a job that holds a 128 MiB heap, and would put
 * two unrelated failure budgets behind one set of connections.
 *
 * Both providers resolve to `null` while the boundary is disabled, so a deployment
 * that has not enabled exports yet opens no socket and registers no consumer. It is
 * not a disabled feature flag checked at the edge of live machinery; there is no
 * machinery.
 */
@Module({
  imports: [
    ConfigModule.forFeature(reportsConfig),
    DatabaseModule,
    ObjectStorageModule,
    // The worker reads the outbox the API writes, owns the export job, and inserts the
    // cleanup safeguard that covers its uploads. Registering all three here keeps the
    // worker context independent of the API module graph.
    TypeOrmModule.forFeature([OutboxEvent, ExportJob, StorageCleanupTask]),
  ],
  providers: [
    {
      provide: ROOM_EXPORT_QUEUE_CLIENT,
      inject: [reportsConfig.KEY],
      useFactory: (configuration: ConfigType<typeof reportsConfig>) => {
        if (!configuration.enabled) return null;
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
        reportRedisClientErrors(client, 'room-export-queue');
        return client;
      },
    },
    {
      provide: ROOM_EXPORT_QUEUE,
      inject: [reportsConfig.KEY, ROOM_EXPORT_QUEUE_CLIENT],
      useFactory: (
        configuration: ConfigType<typeof reportsConfig>,
        client: Redis | null,
      ) =>
        client === null
          ? null
          : new Queue(configuration.queue.name, {
              connection: client,
              prefix: configuration.queue.prefix,
            }),
    },
    RoomExportQueueLifecycle,
    RoomExportSnapshotRepository,
    RoomExportGeneratorService,
    RoomExportStorageService,
    RoomExportAttemptRepository,
    OutboxClaimRepository,
    RoomExportDispatcherService,
    RoomExportConsumerService,
    {
      // The consumer needs a connection of its own: BullMQ workers hold a blocking
      // command open, which would stall every producer command sharing the socket.
      provide: ROOM_EXPORT_WORKER_CLIENT,
      inject: [reportsConfig.KEY],
      useFactory: (configuration: ConfigType<typeof reportsConfig>) => {
        if (!configuration.enabled) return null;
        const { connection } = configuration.queue;
        const client = new Redis({
          host: connection.host,
          port: connection.port,
          lazyConnect: true,
          maxRetriesPerRequest: null,
          connectTimeout: connection.timeoutMs,
        });
        reportRedisClientErrors(client, 'room-export-worker');
        return client;
      },
    },
  ],
  exports: [
    ConfigModule,
    TypeOrmModule,
    ROOM_EXPORT_QUEUE,
    ROOM_EXPORT_QUEUE_CLIENT,
    RoomExportSnapshotRepository,
    RoomExportGeneratorService,
    RoomExportStorageService,
    RoomExportAttemptRepository,
    RoomExportDispatcherService,
    RoomExportConsumerService,
  ],
})
export class ReportsWorkerModule {}
