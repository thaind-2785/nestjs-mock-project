import { Logger } from '@nestjs/common';
import { toBookingLifecycleMessage } from '../bookings/booking-lifecycle-message';
import { toBookingLifecyclePayload } from '../bookings/booking-lifecycle-payload';
import { BookingStatus } from '../bookings/entities/booking.enums';
import type { DatabaseConnectionService } from '../database/database-connection.service';
import { BookingStatsProjectionService } from './booking-stats-projection.service';
import type {
  BookingStatsFactRow,
  ReceivedStatsMessage,
} from './booking-stats.types';

let offset = 0;

function message(
  publicId: string,
  version: number,
  status: BookingStatus,
): ReceivedStatsMessage {
  const payload = toBookingLifecyclePayload({
    booking: {
      publicId,
      version: String(version),
      status,
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      priceAmount: '1000',
      currency: 'VND',
    },
    room: { id: '12', roomTypeId: '3' },
    fromStatus: version === 1 ? null : BookingStatus.Pending,
  });
  const id = `9d1c2f0e-7a5b-4c3e-9f1a-${String(offset).padStart(12, '0')}`;
  offset += 1;
  return {
    partition: 0,
    offset: String(offset),
    value: toBookingLifecycleMessage(
      { id, payload, createdAt: new Date('2026-09-29T08:00:00.000Z') },
      payload,
    ).value,
  };
}

function setup() {
  const upsert = jest.fn<Promise<void>, [unknown, BookingStatsFactRow[]]>(() =>
    Promise.resolve(),
  );
  const transaction = jest.fn((work: (manager: unknown) => unknown) =>
    work({}),
  );
  const database = {
    ensureInitialized: () => Promise.resolve({ transaction }),
  } as unknown as DatabaseConnectionService;
  const projection = new BookingStatsProjectionService(
    database,
    { upsert },
    null,
  );
  return { projection, upsert, transaction };
}

describe('BookingStatsProjectionService', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('writes the newest version of each booking once, in booking order, in one transaction', async () => {
    const { projection, upsert, transaction } = setup();

    const result = await projection.applyBatch([
      message('01K4N8G4X8R0K1F2Q7V6S9T3AC', 1, BookingStatus.Pending),
      message('01K4N8G4X8R0K1F2Q7V6S9T3AB', 2, BookingStatus.Confirmed),
      message('01K4N8G4X8R0K1F2Q7V6S9T3AB', 1, BookingStatus.Pending),
    ]);

    expect(result).toEqual({ received: 3, applied: 2, skipped: 0 });
    expect(transaction).toHaveBeenCalledTimes(1);
    const rows = upsert.mock.calls[0][1];
    expect(
      rows.map((row) => [row.bookingPublicId, row.bookingVersion, row.status]),
    ).toEqual([
      ['01K4N8G4X8R0K1F2Q7V6S9T3AB', 2, 'CONFIRMED'],
      ['01K4N8G4X8R0K1F2Q7V6S9T3AC', 1, 'PENDING'],
    ]);
  });

  it('skips a message that breaks the contract and logs its position, not its value', async () => {
    const { projection, upsert } = setup();

    const result = await projection.applyBatch([
      { partition: 2, offset: '41', value: '{"secret":"guest@example.com"}' },
      message('01K4N8G4X8R0K1F2Q7V6S9T3AB', 1, BookingStatus.Pending),
    ]);

    expect(result).toEqual({ received: 2, applied: 1, skipped: 1 });
    expect(upsert.mock.calls[0][1]).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith({
      event: 'booking_stats_message_skipped',
      partition: 2,
      offset: '41',
      errorCode: 'BOOKING_STREAM_EVENT_INVALID',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('guest@example.com');
  });

  it('opens no transaction when a batch has nothing to apply', async () => {
    const { projection, transaction } = setup();

    await expect(
      projection.applyBatch([{ partition: 0, offset: '1', value: null }]),
    ).resolves.toEqual({ received: 1, applied: 0, skipped: 1 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
