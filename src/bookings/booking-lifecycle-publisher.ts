import type { BookingLifecycleMessage } from './booking-lifecycle-relay.types';

/**
 * The port the relay publishes through. Kafka is the adapter today; `ADR-0012` keeps
 * the client replaceable because `kafkajs` is no longer developed upstream.
 */
export interface BookingLifecyclePublisher {
  /**
   * Publishes one batch in one request and resolves only once the broker acknowledged
   * all of it. A rejection means some messages may have been written, so the caller
   * must be willing to publish the whole batch again.
   */
  publish(messages: readonly BookingLifecycleMessage[]): Promise<void>;
  close(): Promise<void>;
}

export const BOOKING_LIFECYCLE_PUBLISHER = Symbol(
  'BOOKING_LIFECYCLE_PUBLISHER',
);
