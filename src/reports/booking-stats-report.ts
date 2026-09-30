import { BookingStatus } from '../bookings/entities/booking.enums';
import { bookingStatsRevenueStatuses } from './booking-stats.constants';
import { bookingStatsErrors } from './booking-stats.errors';
import type {
  BookingStatsAggregateRow,
  BookingStatsBucket,
  BookingStatsSummary,
} from './booking-stats.types';

const statuses = Object.values(BookingStatus);

/**
 * Folds aggregate rows into the report's shape: every status present, revenue per
 * currency, buckets in period order. Pure, so the arithmetic is tested without MySQL.
 *
 * Amounts are summed as `bigint` and only converted at the end, because MySQL returns
 * `SUM` of a `BIGINT` as a decimal string and a running `number` would round silently
 * long before the final check could see it.
 */
export function summarizeBookingStats(
  rows: readonly BookingStatsAggregateRow[],
): {
  totals: BookingStatsSummary;
  buckets: BookingStatsBucket[];
} {
  const totals = new SummaryBuilder();
  const buckets = new Map<string, SummaryBuilder>();
  for (const row of rows) {
    totals.add(row);
    if (row.period === null) continue;
    let bucket = buckets.get(row.period);
    if (!bucket) {
      bucket = new SummaryBuilder();
      buckets.set(row.period, bucket);
    }
    bucket.add(row);
  }
  return {
    totals: totals.build(),
    buckets: [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([period, bucket]) => ({ period, ...bucket.build() })),
  };
}

class SummaryBuilder {
  private bookings = 0;
  private readonly byStatus = Object.fromEntries(
    statuses.map((status) => [status, 0]),
  ) as Record<BookingStatus, number>;
  private readonly revenue = new Map<string, bigint>();

  add(row: BookingStatsAggregateRow): void {
    const count = Number(row.bookings);
    this.bookings += count;
    this.byStatus[row.status] += count;
    if (!bookingStatsRevenueStatuses.includes(row.status)) return;
    const amount = BigInt(String(row.amount ?? 0));
    this.revenue.set(
      row.currency,
      (this.revenue.get(row.currency) ?? 0n) + amount,
    );
  }

  build(): BookingStatsSummary {
    return {
      bookings: this.bookings,
      byStatus: { ...this.byStatus },
      projectedRevenue: [...this.revenue.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => {
          if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw bookingStatsErrors.amountOutOfRange();
          }
          return { currency, amount: Number(amount) };
        }),
    };
  }
}
