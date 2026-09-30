import type { BookingStatsBatchHandler } from './booking-stats.types';

/**
 * The port the statistics projection consumes through. The Kafka adapter owns the
 * group, the subscription and offset commits; the projection sees plain messages.
 */
export interface BookingStatsConsumer {
  /**
   * Begins consuming in the background and never rejects: a broker that cannot be
   * reached is retried by the adapter, so the worker starts either way. Offsets of a
   * batch are committed only after `handler` resolves.
   */
  start(handler: BookingStatsBatchHandler): void;
  stop(): Promise<void>;
}

export const BOOKING_STATS_CONSUMER = Symbol('BOOKING_STATS_CONSUMER');
