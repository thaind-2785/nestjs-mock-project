import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { reportRedisClientErrors } from '../common/redis/redis-client-errors';
import { reportsConfig } from '../config/reports.config';
import { DatabaseModule } from '../database/database.module';
import { RoomExportGeneratorService } from './room-export-generator.service';
import { RoomExportSnapshotRepository } from './room-export-snapshot.repository';
import { RoomExportQueueLifecycle } from './room-export-queue.lifecycle';
import { ROOM_EXPORT_QUEUE, ROOM_EXPORT_QUEUE_CLIENT } from './report.tokens';

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
  imports: [ConfigModule.forFeature(reportsConfig), DatabaseModule],
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
  ],
  exports: [
    ConfigModule,
    ROOM_EXPORT_QUEUE,
    ROOM_EXPORT_QUEUE_CLIENT,
    RoomExportSnapshotRepository,
    RoomExportGeneratorService,
  ],
})
export class ReportsWorkerModule {}
