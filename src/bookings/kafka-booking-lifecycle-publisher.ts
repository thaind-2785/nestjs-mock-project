import { Logger } from '@nestjs/common';
import { Partitioners, type Kafka, type Producer } from 'kafkajs';
import { createKafkaClient } from '../common/kafka/kafka-client';
import type { BookingStreamConfiguration } from '../config/booking-stream.config';
import { bookingLifecyclePublishTimeoutName } from './booking-lifecycle-event.constants';
import { ensureBookingLifecycleTopic } from './booking-lifecycle-topic';
import type { BookingLifecyclePublisher } from './booking-lifecycle-publisher';
import type { BookingLifecycleMessage } from './booking-lifecycle-relay.types';

/**
 * The Kafka adapter behind `BookingLifecyclePublisher`.
 *
 * The producer is idempotent, which makes the broker discard duplicates caused by the
 * client's own retries and implies `acks=all`; one request in flight keeps a retried
 * request from overtaking the one after it. The Java-compatible murmur2 partitioner is
 * named explicitly, so a consumer in any language computes the same partition for a
 * booking key.
 *
 * Nothing connects until the first publish. The topic is ensured on that connection
 * rather than at startup, so a worker that starts while the broker is down still starts
 * - its relay retries - instead of crashing into a restart loop.
 */
export class KafkaBookingLifecyclePublisher implements BookingLifecyclePublisher {
  private readonly logger = new Logger(KafkaBookingLifecyclePublisher.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  /**
   * Reset to `undefined` whenever connecting or publishing fails, so the next publish
   * connects and ensures the topic again.
   */
  private ready: Promise<void> | undefined;

  constructor(private readonly configuration: BookingStreamConfiguration) {
    this.kafka = createKafkaClient(configuration.client, this.logger);
    this.producer = this.kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
      // Explicit, because an idempotent producer otherwise retries without limit and the
      // bound `assertBookingStreamBounds` checks would describe a client that does not
      // exist. The client warns that a finite budget weakens its exactly-once guarantee;
      // this stream promises at-least-once, and consumers deduplicate by `event-id`.
      retry: {
        retries: configuration.client.retries,
        maxRetryTime: configuration.client.maxRetryTimeMs,
      },
    });
  }

  async publish(messages: readonly BookingLifecycleMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await withTimeout(
      this.send(messages),
      this.configuration.client.publishTimeoutMs,
    );
  }

  async close(): Promise<void> {
    await this.producer.disconnect();
  }

  private async send(
    messages: readonly BookingLifecycleMessage[],
  ): Promise<void> {
    await this.ensureReady();
    try {
      await this.sendReady(messages);
    } catch (error: unknown) {
      // Any failed publish re-runs the topic check on the next cycle. The case this
      // exists for is a topic that disappeared under a live worker - a volume reset or
      // a deliberate delete before a replay - which auto-creation, refused by the
      // broker, will never repair. One extra `createTopics` per failed cycle is the cost.
      this.ready = undefined;
      throw error;
    }
  }

  private async sendReady(
    messages: readonly BookingLifecycleMessage[],
  ): Promise<void> {
    await this.producer.send({
      topic: this.configuration.topic.name,
      acks: -1,
      timeout: this.configuration.client.requestTimeoutMs,
      messages: messages.map((message) => ({
        key: message.key,
        value: message.value,
        timestamp: String(message.timestampMs),
        headers: message.headers,
      })),
    });
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.connect().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async connect(): Promise<void> {
    await ensureBookingLifecycleTopic(
      this.kafka,
      this.configuration,
      this.logger,
    );
    await this.producer.connect();
  }
}

/**
 * Bounds a publish the client might otherwise keep retrying. The underlying request is
 * not cancelled - the client offers no way to - so a late success is possible and is
 * exactly the duplicate the consumer contract already absorbs.
 */
async function withTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Booking lifecycle publish timed out');
      error.name = bookingLifecyclePublishTimeoutName;
      reject(error);
    }, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}
