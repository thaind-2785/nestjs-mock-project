import type { DatabaseConnectionService } from '../database/database-connection.service';
import { createBookingStreamConfiguration } from '../config/booking-stream.config';
import { validateEnvironment } from '../config/environment.validation';
import { BookingStatsReportService } from './booking-stats-report.service';

function service(enabled: boolean) {
  const aggregate = jest.fn().mockResolvedValue([]);
  const asOf = jest.fn().mockResolvedValue(null);
  const reports = new BookingStatsReportService(
    {
      ensureInitialized: () => Promise.resolve({ manager: {} }),
    } as unknown as DatabaseConnectionService,
    { aggregate, asOf },
    createBookingStreamConfiguration(
      validateEnvironment({ BOOKING_STREAM_ENABLED: String(enabled) }),
    ),
  );
  return { reports, aggregate };
}

describe('BookingStatsReportService', () => {
  it('refuses while the stream is off, before reading anything', async () => {
    const { reports, aggregate } = service(false);

    await expect(
      reports.report({ from: '2026-10-01', to: '2026-11-01' }),
    ).rejects.toMatchObject({ errorCode: 'BOOKING_STATS_DISABLED' });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', '2026-10-01', '2026-10-01'],
    ['inverted', '2026-10-02', '2026-10-01'],
    ['longer than 366 days', '2026-01-01', '2027-01-03'],
  ])('refuses a range that is %s', async (_label, from, to) => {
    const { reports, aggregate } = service(true);

    await expect(reports.report({ from, to })).rejects.toMatchObject({
      errorCode: 'BOOKING_STATS_RANGE_INVALID',
    });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('accepts exactly 366 days and echoes the filters it used', async () => {
    const { reports } = service(true);

    await expect(
      reports.report({
        from: '2028-01-01',
        to: '2029-01-01',
        groupBy: 'month',
      }),
    ).resolves.toMatchObject({
      from: '2028-01-01',
      to: '2029-01-01',
      roomTypeId: null,
      groupBy: 'month',
      asOf: null,
      totals: { bookings: 0, projectedRevenue: [] },
      buckets: [],
    });
  });
});
