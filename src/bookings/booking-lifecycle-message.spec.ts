import { toBookingLifecycleMessage } from './booking-lifecycle-message';
import { toBookingLifecyclePayload } from './booking-lifecycle-payload';
import { BookingStatus } from './entities/booking.enums';

describe('toBookingLifecycleMessage', () => {
  it('keys by booking and wraps the payload in the published envelope', () => {
    const payload = toBookingLifecyclePayload({
      booking: {
        publicId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
        version: '1',
        status: BookingStatus.Pending,
        checkIn: '2026-10-10',
        checkOut: '2026-10-12',
        priceAmount: '2400000',
        currency: 'VND',
      },
      room: { id: '12', roomTypeId: '3' },
      fromStatus: null,
    });
    const createdAt = new Date('2026-09-29T08:15:30.123Z');

    const message = toBookingLifecycleMessage(
      { id: '9d1c2f0e-7a5b-4c3e-9f1a-2b6d8e4c1a70', payload, createdAt },
      payload,
    );

    expect(message.key).toBe('01K4N8G4X8R0K1F2Q7V6S9T3AB');
    expect(message.timestampMs).toBe(createdAt.getTime());
    expect(message.headers).toEqual({
      'event-id': '9d1c2f0e-7a5b-4c3e-9f1a-2b6d8e4c1a70',
      'event-type': 'booking-lifecycle.recorded',
      'schema-version': '1',
    });
    expect(JSON.parse(message.value)).toEqual({
      eventId: '9d1c2f0e-7a5b-4c3e-9f1a-2b6d8e4c1a70',
      eventType: 'booking-lifecycle.recorded',
      occurredAt: '2026-09-29T08:15:30.123Z',
      ...payload,
    });
  });
});
