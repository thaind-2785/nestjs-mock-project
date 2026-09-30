import type { EntityManager } from 'typeorm';
import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { createBookingStreamConfiguration } from '../config/booking-stream.config';
import { validateEnvironment } from '../config/environment.validation';
import { BookingLifecycleRecorder } from './booking-lifecycle-recorder';
import { BookingStatus } from './entities/booking.enums';

function recorder(enabled: boolean): BookingLifecycleRecorder {
  return new BookingLifecycleRecorder(
    createBookingStreamConfiguration(
      validateEnvironment({ BOOKING_STREAM_ENABLED: String(enabled) }),
    ),
  );
}

const change = {
  booking: {
    publicId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
    version: '3',
    status: BookingStatus.Rejected,
    checkIn: '2026-10-10',
    checkOut: '2026-10-12',
    priceAmount: '2400000',
    currency: 'VND',
  },
  room: { id: '12', roomTypeId: '3' },
  fromStatus: BookingStatus.Pending,
};

describe('BookingLifecycleRecorder', () => {
  it('writes nothing while the stream is disabled', async () => {
    const insert = jest.fn();
    const manager = { insert } as unknown as EntityManager;

    await recorder(false).record(manager, change);

    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts one pending row through the caller-owned manager', async () => {
    const insert = jest.fn<Promise<void>, [unknown, Record<string, unknown>]>(
      () => Promise.resolve(),
    );
    const manager = { insert } as unknown as EntityManager;

    await recorder(true).record(manager, change);

    expect(insert).toHaveBeenCalledTimes(1);
    const [target, row] = insert.mock.calls[0];
    expect(target).toBe(OutboxEvent);
    expect(row).toMatchObject({
      eventType: 'booking-lifecycle.recorded',
      status: 'PENDING',
      attempts: 0,
      idempotencyKey: 'booking-lifecycle.recorded:01K4N8G4X8R0K1F2Q7V6S9T3AB:3',
      payload: {
        bookingVersion: 3,
        fromStatus: 'PENDING',
        toStatus: 'REJECTED',
      },
    });
  });
});
