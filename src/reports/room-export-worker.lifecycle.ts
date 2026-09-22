import type { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import type { RoomExportAttemptOutcome } from './room-export-consumer.types';
import type { RoomExportJobData } from './room-export-dispatcher.types';

interface RoomExportWorkerStartOptions {
  queueName: string;
  queuePrefix: string;
  concurrency: number;
  client: Redis;
  process: (data: RoomExportJobData) => Promise<RoomExportAttemptOutcome>;
  logger: Logger;
}

/** Owns the one mutable BullMQ handle behind a stable, readonly service field. */
export class RoomExportWorkerLifecycle {
  private current:
    Worker<RoomExportJobData, RoomExportAttemptOutcome> | undefined;

  start(options: RoomExportWorkerStartOptions): void {
    if (this.current) return;
    const worker = new Worker<RoomExportJobData, RoomExportAttemptOutcome>(
      options.queueName,
      (job) => options.process(job.data),
      {
        connection: options.client,
        prefix: options.queuePrefix,
        concurrency: options.concurrency,
      },
    );
    // BullMQ swallows an unhandled `error` to the console, so a Redis outage would
    // otherwise leave no structured record that the consumer is failing at all.
    worker.on('error', (error: Error) => {
      options.logger.error({
        event: 'room_export_consumer_error',
        reason: error.name,
      });
    });
    worker.on('failed', (job, error: Error) => {
      options.logger.error({
        event: 'room_export_job_failed',
        outboxEventId: job?.data.outboxEventId,
        attempt: job?.data.attempt,
        reason: error.name,
      });
    });
    this.current = worker;
  }

  async close(): Promise<void> {
    await this.current?.close();
    this.current = undefined;
  }
}
