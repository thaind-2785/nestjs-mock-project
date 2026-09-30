import { BookingStatus } from '../bookings/entities/booking.enums';

/**
 * Rows per upsert statement. One fetched batch can hold thousands of messages; a
 * statement per few hundred keeps each one well below `max_allowed_packet` and keeps
 * the row locks one statement holds short.
 */
export const bookingStatsUpsertChunkSize = 500;

/**
 * The longest range one report may cover, in days: a year, leap day included. Past it
 * a daily breakdown stops being a screen and becomes an export, which is a different
 * feature with its own bounds.
 */
export const bookingStatsMaxRangeDays = 366;

/** Statuses whose price snapshot counts as projected revenue (`SPEC-012`). */
export const bookingStatsRevenueStatuses: readonly BookingStatus[] = [
  BookingStatus.Confirmed,
  BookingStatus.Completed,
];

export const bookingStatsGroupings = ['day', 'month'] as const;

/** Stable codes the rebuild command reports; never a broker message. */
export const bookingStatsRebuildErrorCodes = {
  consumerActive: 'BOOKING_STATS_CONSUMER_ACTIVE',
  /** A consumer joined while the table was being emptied; run the command again. */
  consumerJoined: 'BOOKING_STATS_CONSUMER_JOINED',
  topicMissing: 'BOOKING_STATS_TOPIC_MISSING',
} as const;

/** Facts deleted per statement while the rebuild empties the read model. */
export const bookingStatsRebuildDeleteBatchSize = 1_000;
