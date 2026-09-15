import { BookingStatus } from '../bookings/entities/booking.enums';
import {
  NotificationEventError,
  notificationEventErrorCodes,
  parseNotificationEvent,
} from './notification-event';

const bookingId = '01K5ABCDEF0123456789ABCDEF';

function confirmedPayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bookingId,
    ownerUserId: '42',
    bookingVersion: 2,
    booking: {
      room: { id: '7', roomNumber: 'A-201' },
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      status: BookingStatus.Confirmed,
      price: { amount: 3_000_000, currency: 'VND' },
    },
  };
}

function withReason(
  status: BookingStatus,
  reason = 'Dates are unavailable.',
): Record<string, unknown> {
  const payload = confirmedPayload();
  payload.booking = {
    ...(payload.booking as Record<string, unknown>),
    status,
    reason,
  };
  return payload;
}

function changedPayload(): Record<string, unknown> {
  return {
    ...withReason(BookingStatus.Pending, 'Guest requested the new dates.'),
    before: {
      roomId: '6',
      checkIn: '2026-09-20',
      checkOut: '2026-09-22',
    },
    after: {
      roomId: '7',
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
    },
  };
}

describe('parseNotificationEvent', () => {
  it.each([
    ['booking.confirmed', confirmedPayload()],
    ['booking.rejected', withReason(BookingStatus.Rejected)],
    ['booking.changed', changedPayload()],
    ['booking.cancelled_by_admin', withReason(BookingStatus.CancelledByAdmin)],
  ] as const)(
    'accepts the versioned %s payload contract',
    (eventType, payload) => {
      const event = parseNotificationEvent(eventType, payload);

      expect(event.type).toBe(eventType);
      expect(event.schemaVersion).toBe(1);
      expect(event.bookingId).toBe(bookingId);
    },
  );

  it('distinguishes unsupported event types and schema versions', () => {
    expectError(
      () => parseNotificationEvent('booking.created', confirmedPayload()),
      notificationEventErrorCodes.unsupportedType,
    );
    expectError(
      () =>
        parseNotificationEvent('booking.confirmed', {
          ...confirmedPayload(),
          schemaVersion: 2,
        }),
      notificationEventErrorCodes.unsupportedVersion,
    );
  });

  const invalidCases: Array<
    [string, (payload: Record<string, unknown>) => void]
  > = [
    ['public ULID', (payload) => void (payload.bookingId = 'not-a-ulid')],
    ['owner ID', (payload) => void (payload.ownerUserId = '0')],
    ['schema version shape', (payload) => void delete payload.schemaVersion],
    ['booking version', (payload) => void (payload.bookingVersion = 1.5)],
    [
      'calendar date',
      (payload) => void (bookingOf(payload).checkIn = '2026-02-30'),
    ],
    [
      'date order',
      (payload) => void (bookingOf(payload).checkOut = '2026-09-30'),
    ],
    ['safe money', (payload) => void (priceOf(payload).amount = 1.5)],
    ['ISO currency', (payload) => void (priceOf(payload).currency = 'ZZZ')],
    ['room number bounds', (payload) => void (roomOf(payload).roomNumber = '')],
    [
      'status contract',
      (payload) => void (bookingOf(payload).status = BookingStatus.Pending),
    ],
    [
      'exact envelope',
      (payload) => void (payload.cc = 'attacker@invalid.test'),
    ],
  ];

  it.each(invalidCases)('rejects an invalid %s', (_case, mutate) => {
    const payload = confirmedPayload();
    mutate(payload);

    expectError(
      () => parseNotificationEvent('booking.confirmed', payload),
      notificationEventErrorCodes.invalid,
    );
  });

  it.each(['', ' untrimmed ', `unsafe\u0000reason`])(
    'rejects unsafe or malformed required reason %p',
    (reason) => {
      expectError(
        () =>
          parseNotificationEvent(
            'booking.rejected',
            withReason(BookingStatus.Rejected, reason),
          ),
        notificationEventErrorCodes.invalid,
      );
    },
  );

  it('requires a real change whose after snapshot matches the booking snapshot', () => {
    const noChange = changedPayload();
    noChange.before = structuredClone(noChange.after);
    const driftedAfter = changedPayload();
    (driftedAfter.after as Record<string, unknown>).roomId = '8';

    expectError(
      () => parseNotificationEvent('booking.changed', noChange),
      notificationEventErrorCodes.invalid,
    );
    expectError(
      () => parseNotificationEvent('booking.changed', driftedAfter),
      notificationEventErrorCodes.invalid,
    );
  });

  it('does not include rejected payload values in parser errors', () => {
    const secretReason = 'sensitive-reason-value';
    const payload = withReason(BookingStatus.Rejected, secretReason);
    (payload.booking as Record<string, unknown>).reason = ` ${secretReason} `;

    expect(() => parseNotificationEvent('booking.rejected', payload)).toThrow(
      'Invalid notification event field: booking.reason',
    );
    try {
      parseNotificationEvent('booking.rejected', payload);
    } catch (error) {
      expect((error as Error).message).not.toContain(secretReason);
    }
  });
});

function bookingOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.booking as Record<string, unknown>;
}

function roomOf(payload: Record<string, unknown>): Record<string, unknown> {
  return bookingOf(payload).room as Record<string, unknown>;
}

function priceOf(payload: Record<string, unknown>): Record<string, unknown> {
  return bookingOf(payload).price as Record<string, unknown>;
}

function expectError(
  action: () => unknown,
  code: NotificationEventError['code'],
): void {
  try {
    action();
    throw new Error('Expected notification event parsing to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(NotificationEventError);
    expect((error as NotificationEventError).code).toBe(code);
  }
}
