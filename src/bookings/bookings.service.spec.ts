import { DataSource, EntityManager } from 'typeorm';
import { BookingsService } from './bookings.service';
import { IdempotencyKeyStatus } from './entities/booking.enums';

describe('BookingsService', () => {
  it('replays a completed request before applying today-date policy again', async () => {
    const replay = {
      id: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      room: {
        id: '42',
        roomNumber: 'A-201',
        roomType: { id: '7', name: 'Deluxe' },
      },
      checkIn: '2026-01-01',
      checkOut: '2026-01-03',
      nights: 2,
      status: 'PENDING' as const,
      price: { amount: 3_000_000, currency: 'VND' },
      rejectionReason: null,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      findOneOrFail: jest.fn().mockResolvedValue({
        status: IdempotencyKeyStatus.Completed,
        requestFingerprint:
          'a7ceecce43a9c3766a8caec554b5db900d1fd00ceedab7b45bf5f7fc1f442485',
        responseBody: replay,
      }),
    } as unknown as EntityManager;
    const service = new BookingsService(
      {
        transaction: (callback: (transaction: EntityManager) => unknown) =>
          callback(manager),
      } as unknown as DataSource,
      {
        hotelTimezone: 'Asia/Ho_Chi_Minh',
        createRateLimit: { max: 10, windowSeconds: 60 },
        idempotencyRetentionHours: 24,
      },
    );
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    try {
      await expect(
        service.create(
          '1',
          'booking-replay-after-checkin',
          {
            roomId: '42',
            checkIn: '2026-01-01',
            checkOut: '2026-01-03',
          },
          'request-123',
        ),
      ).resolves.toEqual(replay);
      expect(log).toHaveBeenCalledWith({
        event: 'booking_create_replayed',
        requestId: 'request-123',
        operation: 'BOOKING_CREATE',
        actorType: 'USER',
        publicBookingId: replay.id,
        result: 'replayed',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('emits a sanitized idempotency conflict event', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue(undefined),
      findOneOrFail: jest.fn().mockResolvedValue({
        status: IdempotencyKeyStatus.Completed,
        requestFingerprint: 'different-fingerprint',
        responseBody: {},
      }),
    } as unknown as EntityManager;
    const service = new BookingsService(
      {
        transaction: (callback: (transaction: EntityManager) => unknown) =>
          callback(manager),
      } as unknown as DataSource,
      {
        hotelTimezone: 'Asia/Ho_Chi_Minh',
        createRateLimit: { max: 10, windowSeconds: 60 },
        idempotencyRetentionHours: 24,
      },
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    try {
      await expect(
        service.create(
          '1',
          'booking-replay-after-checkin',
          { roomId: '42', checkIn: '2026-01-01', checkOut: '2026-01-03' },
          'request-456',
        ),
      ).rejects.toMatchObject({ errorCode: 'IDEMPOTENCY_KEY_REUSED' });
      expect(warn).toHaveBeenCalledWith({
        event: 'booking_idempotency_conflict',
        requestId: 'request-456',
        operation: 'BOOKING_CREATE',
        actorType: 'USER',
        result: 'conflict',
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
      });
    } finally {
      warn.mockRestore();
    }
  });
});
import { Logger } from '@nestjs/common';
