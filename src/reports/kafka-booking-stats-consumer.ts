import { Logger } from '@nestjs/common';
import type { Consumer, Kafka } from 'kafkajs';
import { ensureBookingLifecycleTopic } from '../bookings/booking-lifecycle-topic';
import { createKafkaClient } from '../common/kafka/kafka-client';
import { describeKafkaError } from '../common/kafka/kafka-error';
import type { BookingStreamConfiguration } from '../config/booking-stream.config';
import { consumeBookingStatsBatch } from './booking-stats-batch';
import type { BookingStatsConsumer } from './booking-stats-consumer';
import type { BookingStatsBatchHandler } from './booking-stats.types';

/**
 * The Kafka adapter behind `BookingStatsConsumer`.
 *
 * Offsets are committed by hand, after the handler's transaction has committed, and
 * never automatically (`consumeBookingStatsBatch`). A handler that throws commits
 * nothing: the client retries the batch within its retry budget and, past it, restarts
 * the consumer from the last committed offset.
 *
 * The adapter keeps itself running. A connect that fails is retried after a delay, and
 * so is a crash the client chose not to restart - which it does for any error it does
 * not recognise as retriable - so the worker never keeps running with no consumer. A
 * stop is honoured between every startup step, so a consumer being stopped never joins
 * the group afterwards and blocks a rebuild.
 *
 * A new group starts from the earliest offset, which is what lets the rebuild command
 * reset the group and have the next run replay the whole topic.
 */
export class KafkaBookingStatsConsumer implements BookingStatsConsumer {
  private readonly logger = new Logger(KafkaBookingStatsConsumer.name);
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  /** Lifecycle state: the handler to restart with, the pending retry, the startup in
   * flight, and whether a stop has been asked for. */
  private handler: BookingStatsBatchHandler | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempting: Promise<void> | undefined;
  private stopping = false;

  constructor(private readonly configuration: BookingStreamConfiguration) {
    this.kafka = createKafkaClient(configuration.client, this.logger);
    const { consumer } = configuration;
    this.consumer = this.kafka.consumer({
      groupId: consumer.statsGroupId,
      sessionTimeout: consumer.sessionTimeoutMs,
      heartbeatInterval: consumer.heartbeatIntervalMs,
      allowAutoTopicCreation: false,
      // Its own budget rather than the producer's two quick retries: a batch that fails
      // on MySQL should be retried for a while before the consumer is torn down.
      retry: {
        retries: consumer.retries,
        initialRetryTime: consumer.initialRetryTimeMs,
        maxRetryTime: consumer.maxRetryTimeMs,
      },
    });
    this.consumer.on(this.consumer.events.CRASH, (event) => {
      const { error, restart } = event.payload;
      this.logger.error({
        event: 'booking_stats_consumer_error',
        ...describeKafkaError(error),
        restart,
      });
      // The client has already disconnected. When it will not restart on its own, this
      // adapter does, after the same delay as a failed connect.
      if (!restart) this.retryLater();
    });
  }

  start(handler: BookingStatsBatchHandler): void {
    this.handler = handler;
    this.launch();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    await this.attempting;
    // Waits for a batch in flight to finish and commit, so a deploy does not turn every
    // stop into a redelivery.
    await this.consumer.disconnect();
  }

  private launch(): void {
    if (this.stopping || this.attempting) return;
    this.attempting = this.attempt().finally(() => {
      this.attempting = undefined;
    });
  }

  private retryLater(): void {
    if (this.stopping) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => this.launch(),
      this.configuration.consumer.reconnectDelayMs,
    );
  }

  private async attempt(): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    try {
      await ensureBookingLifecycleTopic(
        this.kafka,
        this.configuration,
        this.logger,
      );
      if (this.stopping) return;
      await this.consumer.connect();
      if (this.stopping) return;
      await this.consumer.subscribe({
        topic: this.configuration.topic.name,
        fromBeginning: true,
      });
      if (this.stopping) return;
      await this.consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: (payload) => consumeBookingStatsBatch(payload, handler),
      });
      this.logger.log({
        event: 'booking_stats_consumer_started',
        groupId: this.configuration.consumer.statsGroupId,
        topic: this.configuration.topic.name,
      });
    } catch (error: unknown) {
      this.logger.warn({
        event: 'booking_stats_consumer_connect_failed',
        ...describeKafkaError(error),
        retryInMs: this.configuration.consumer.reconnectDelayMs,
      });
      await this.consumer.disconnect().catch(() => {
        // Nothing to disconnect is not a second failure.
      });
      this.retryLater();
    }
  }
}
