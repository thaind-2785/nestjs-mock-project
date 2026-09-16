import type { Logger } from '@nestjs/common';
import { Worker } from 'bullmq';
import type Redis from 'ioredis';
import type { NotificationJobData } from './outbox-dispatcher.types';
import type { DeliveryOutcome } from './delivery-worker.types';

interface NotificationWorkerStartOptions {
  queueName: string;
  queuePrefix: string;
  concurrency: number;
  client: Redis;
  process: (data: NotificationJobData) => Promise<DeliveryOutcome>;
  logger: Logger;
}

/** Owns the one mutable BullMQ handle behind a stable, readonly service field. */
export class NotificationWorkerLifecycle {
  private current: Worker<NotificationJobData, DeliveryOutcome> | undefined;

  start(options: NotificationWorkerStartOptions): void {
    if (this.current) return;
    const worker = new Worker<NotificationJobData, DeliveryOutcome>(
      options.queueName,
      (job) => options.process(job.data),
      {
        connection: options.client,
        prefix: options.queuePrefix,
        concurrency: options.concurrency,
      },
    );
    // BullMQ swallows an unhandled `error` to the console, so a database outage or a
    // deadlock would otherwise leave no structured record that the consumer is
    // failing at all.
    worker.on('error', (error: Error) => {
      options.logger.error({
        event: 'notification_consumer_error',
        reason: error.name,
      });
    });
    worker.on('failed', (job, error: Error) => {
      options.logger.error({
        event: 'notification_job_failed',
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
