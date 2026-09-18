import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { ROOM_EXPORT_QUEUE, ROOM_EXPORT_QUEUE_CLIENT } from './report.tokens';

/**
 * Owns the shutdown of whatever the export queue providers created.
 *
 * The producer and its socket are built by factories, so without an owner nothing
 * would close them and the worker process would stay alive on a Redis handle after a
 * drain finished. When the export boundary is disabled both are `null` and there is
 * nothing to close, which is the whole point: a disabled deployment opens no
 * connection at all.
 */
@Injectable()
export class RoomExportQueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ROOM_EXPORT_QUEUE) private readonly queue: Queue | null,
    @Inject(ROOM_EXPORT_QUEUE_CLIENT) private readonly client: Redis | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close();
    // BullMQ marks a connection it did not create as shared and leaves it open, so
    // closing the queue is not closing the socket.
    await this.client?.quit();
  }
}
