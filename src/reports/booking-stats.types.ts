import type { BookingStatus } from '../bookings/entities/booking.enums';
import type { bookingStatsGroupings } from './booking-stats.constants';

/** One booking's latest state as the consumer writes it. */
export interface BookingStatsFactRow {
  bookingPublicId: string;
  bookingVersion: number;
  status: BookingStatus;
  roomId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  priceAmount: number;
  currency: string;
  lastEventId: string;
  lastOccurredAt: Date;
}

/** A fetched message, independent of the Kafka client. */
export interface ReceivedStatsMessage {
  partition: number;
  offset: string;
  value: string | null;
}

export interface BookingStatsBatchResult {
  received: number;
  /** Distinct bookings written after in-batch deduplication. */
  applied: number;
  skipped: number;
}

export type BookingStatsBatchHandler = (
  messages: readonly ReceivedStatsMessage[],
) => Promise<BookingStatsBatchResult>;

export type BookingStatsGrouping = (typeof bookingStatsGroupings)[number];

export interface BookingStatsQuery {
  from: string;
  to: string;
  roomTypeId?: string;
  groupBy?: BookingStatsGrouping;
}

/** One aggregate row as MySQL returns it: counts and sums arrive as strings. */
export interface BookingStatsAggregateRow {
  period: string | null;
  status: BookingStatus;
  currency: string;
  bookings: string | number;
  amount: string | number | null;
}

export interface BookingStatsRevenue {
  currency: string;
  amount: number;
}

export interface BookingStatsSummary {
  bookings: number;
  byStatus: Record<BookingStatus, number>;
  projectedRevenue: BookingStatsRevenue[];
}

export interface BookingStatsBucket extends BookingStatsSummary {
  period: string;
}

export interface BookingStatsReport {
  from: string;
  to: string;
  roomTypeId: string | null;
  groupBy: BookingStatsGrouping | null;
  asOf: string | null;
  totals: BookingStatsSummary;
  buckets: BookingStatsBucket[];
}

export interface BookingStatsRebuildResult {
  factsDeleted: number;
}
