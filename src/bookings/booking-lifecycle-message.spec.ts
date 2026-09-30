import {
  parseBookingLifecycleMessage,
  toBookingLifecycleMessage,
} from './booking-lifecycle-message';
import {
  BookingLifecyclePayloadError,
  toBookingLifecyclePayload,
} from './booking-lifecycle-payload';
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

describe('parseBookingLifecycleMessage', () => {
  const eventId = '9d1c2f0e-7a5b-4c3e-9f1a-2b6d8e4c1a70';
  const payload = toBookingLifecyclePayload({
    booking: {
      publicId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      version: '2',
      status: BookingStatus.Confirmed,
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      priceAmount: '2400000',
      currency: 'VND',
    },
    room: { id: '12', roomTypeId: '3' },
    fromStatus: BookingStatus.Pending,
  });
  const published = () =>
    toBookingLifecycleMessage(
      {
        id: eventId,
        payload,
        createdAt: new Date('2026-09-29T08:15:30.123Z'),
      },
      payload,
    ).value;

  it('reads back exactly what the relay publishes', () => {
    expect(parseBookingLifecycleMessage(published())).toEqual({
      eventId,
      occurredAt: new Date('2026-09-29T08:15:30.123Z'),
      payload,
    });
  });

  it('refuses a value that is not the published envelope', () => {
    const envelope = JSON.parse(published()) as Record<string, unknown>;
    for (const value of [
      null,
      'not json',
      '[]',
      JSON.stringify({ ...envelope, eventId: 'not-a-uuid' }),
      JSON.stringify({ ...envelope, eventType: 'booking.confirmed' }),
      JSON.stringify({ ...envelope, occurredAt: '29/09/2026' }),
      // A real instant, but outside what a DATETIME column stores.
      JSON.stringify({ ...envelope, occurredAt: '0999-12-31T00:00:00.000Z' }),
      // A field outside the contract, at the envelope level.
      JSON.stringify({ ...envelope, ownerUserId: '7' }),
    ]) {
      expect(() => parseBookingLifecycleMessage(value)).toThrow(
        BookingLifecyclePayloadError,
      );
    }
  });
});
