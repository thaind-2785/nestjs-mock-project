import type { LoggerService } from '@nestjs/common';
import type { Kafka } from 'kafkajs';
import type { BookingStreamConfiguration } from '../config/booking-stream.config';

/**
 * Creates the lifecycle topic with its reviewed definition if it does not exist.
 *
 * Idempotent: `createTopics` answers `false` for a topic that already exists. The
 * broker refuses auto-creation, so this is the only way the topic comes to exist and a
 * misspelled name fails loudly instead of creating a stray topic. Both ends call it -
 * the relay before its first publish, the statistics consumer before it subscribes -
 * because either may start first against an empty broker.
 */
export async function ensureBookingLifecycleTopic(
  kafka: Kafka,
  configuration: BookingStreamConfiguration,
  logger: Pick<LoggerService, 'log'>,
): Promise<void> {
  const { topic, client } = configuration;
  const admin = kafka.admin();
  await admin.connect();
  try {
    const created = await admin.createTopics({
      waitForLeaders: true,
      timeout: client.requestTimeoutMs,
      topics: [
        {
          topic: topic.name,
          numPartitions: topic.partitions,
          replicationFactor: topic.replicationFactor,
          configEntries: [
            { name: 'retention.ms', value: String(topic.retentionMs) },
          ],
        },
      ],
    });
    logger.log({
      event: 'booking_lifecycle_topic_ensured',
      topic: topic.name,
      created,
    });
  } finally {
    await admin.disconnect();
  }
}
