import { BookingStatus } from '../bookings/entities/booking.enums';
import { summarizeBookingStats } from './booking-stats-report';
import type { BookingStatsAggregateRow } from './booking-stats.types';

function row(
  overrides: Partial<BookingStatsAggregateRow>,
): BookingStatsAggregateRow {
  return {
    period: null,
    status: BookingStatus.Confirmed,
    currency: 'VND',
    bookings: '1',
    amount: '1000',
    ...overrides,
  };
}

describe('summarizeBookingStats', () => {
  it('lists every status and counts revenue only for confirmed and completed stays', () => {
    const { totals, buckets } = summarizeBookingStats([
      row({ status: BookingStatus.Confirmed, bookings: '2', amount: '3000' }),
      row({ status: BookingStatus.Completed, bookings: '1', amount: '500' }),
      row({ status: BookingStatus.Pending, bookings: '4', amount: '9999' }),
      row({ status: BookingStatus.CancelledByAdmin, amount: '7777' }),
    ]);

    expect(totals).toEqual({
      bookings: 8,
      byStatus: {
        PENDING: 4,
        CONFIRMED: 2,
        REJECTED: 0,
        CANCELLED_BY_USER: 0,
        CANCELLED_BY_ADMIN: 1,
        COMPLETED: 1,
      },
      projectedRevenue: [{ currency: 'VND', amount: 3_500 }],
    });
    // Without a grouping every row has a null period, so there are no buckets.
    expect(buckets).toEqual([]);
  });

  it('keeps currencies apart and never converts between them', () => {
    const { totals } = summarizeBookingStats([
      row({ currency: 'VND', amount: '2000000' }),
      row({ currency: 'USD', amount: '8000' }),
    ]);

    expect(totals.projectedRevenue).toEqual([
      { currency: 'USD', amount: 8_000 },
      { currency: 'VND', amount: 2_000_000 },
    ]);
  });

  it('builds ascending buckets that add up to the totals', () => {
    const { totals, buckets } = summarizeBookingStats([
      row({ period: '2026-11-01', bookings: '1', amount: '100' }),
      row({ period: '2026-10-01', bookings: '2', amount: '200' }),
      row({
        period: '2026-10-01',
        status: BookingStatus.Rejected,
        bookings: '1',
        amount: '50',
      }),
    ]);

    expect(buckets.map((bucket) => bucket.period)).toEqual([
      '2026-10-01',
      '2026-11-01',
    ]);
    expect(buckets[0]).toMatchObject({
      bookings: 3,
      projectedRevenue: [{ currency: 'VND', amount: 200 }],
    });
    expect(totals.bookings).toBe(4);
    expect(totals.projectedRevenue).toEqual([{ currency: 'VND', amount: 300 }]);
  });

  it('refuses a total that JSON cannot carry exactly, rather than rounding it', () => {
    const half = (BigInt(Number.MAX_SAFE_INTEGER) / 2n + 1n).toString();

    expect(() =>
      summarizeBookingStats([row({ amount: half }), row({ amount: half })]),
    ).toThrow(
      expect.objectContaining({
        errorCode: 'BOOKING_STATS_AMOUNT_OUT_OF_RANGE',
      }) as Error,
    );
  });
});
