import type { EachBatchPayload } from 'kafkajs';
import type { BookingStatsBatchHandler } from './booking-stats.types';

/**
 * One fetched batch, handled and then committed - in that order and only on success.
 *
 * The committed offset is the next one to read, so `last + 1`. It goes through the
 * payload's own commit rather than the consumer's: the consumer's refuses once a stop
 * has begun, which would drop the commit of a batch a deploy let finish and turn every
 * ordinary restart into a redelivery. A handler that rejects commits nothing and the
 * rejection propagates, so the client retries the batch from the same offset.
 *
 * Separate from the adapter so the ordering - the whole at-least-once argument - is
 * tested without a broker.
 */
export async function consumeBookingStatsBatch(
  payload: Pick<
    EachBatchPayload,
    | 'batch'
    | 'isRunning'
    | 'isStale'
    | 'resolveOffset'
    | 'heartbeat'
    | 'commitOffsetsIfNecessary'
  >,
  handler: BookingStatsBatchHandler,
): Promise<void> {
  const { batch } = payload;
  // A stale batch belongs to a partition this member no longer owns after a rebalance;
  // its new owner reads it from the last commit.
  if (
    !payload.isRunning() ||
    payload.isStale() ||
    batch.messages.length === 0
  ) {
    return;
  }
  await handler(
    batch.messages.map((message) => ({
      partition: batch.partition,
      offset: message.offset,
      value: message.value?.toString('utf8') ?? null,
    })),
  );
  const last = batch.messages[batch.messages.length - 1].offset;
  payload.resolveOffset(last);
  await payload.commitOffsetsIfNecessary({
    topics: [
      {
        topic: batch.topic,
        partitions: [
          {
            partition: batch.partition,
            offset: (BigInt(last) + 1n).toString(),
          },
        ],
      },
    ],
  });
  await payload.heartbeat();
}
