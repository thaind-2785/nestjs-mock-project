import {
  BookingLifecyclePayloadError,
  parseBookingLifecyclePayload,
  toBookingLifecyclePayload,
} from './booking-lifecycle-payload';
import type { BookingLifecycleChange } from './booking-lifecycle-event.types';
import { BookingStatus } from './entities/booking.enums';

function change(
  overrides: Partial<BookingLifecycleChange> = {},
): BookingLifecycleChange {
  return {
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
    ...overrides,
  };
}

describe('toBookingLifecyclePayload', () => {
  it('builds the published allowlist from a status transition', () => {
    expect(toBookingLifecyclePayload(change())).toEqual({
      schemaVersion: 1,
      bookingId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      bookingVersion: 2,
      fromStatus: 'PENDING',
      toStatus: 'CONFIRMED',
      booking: {
        roomId: '12',
        roomTypeId: '3',
        checkIn: '2026-10-10',
        checkOut: '2026-10-12',
        price: { amount: 2_400_000, currency: 'VND' },
      },
      previousStay: null,
    });
  });

  it('carries the previous stay only for a stay change', () => {
    const previousStay = {
      roomId: '11',
      roomTypeId: '3',
      checkIn: '2026-10-09',
      checkOut: '2026-10-11',
    };
    const payload = toBookingLifecyclePayload(
      change({ fromStatus: BookingStatus.Confirmed, previousStay }),
    );

    expect(payload.fromStatus).toBe(payload.toStatus);
    expect(payload.previousStay).toEqual(previousStay);
  });
});

describe('parseBookingLifecyclePayload', () => {
  const valid = () =>
    JSON.parse(JSON.stringify(toBookingLifecyclePayload(change()))) as Record<
      string,
      unknown
    >;

  function rejects(mutate: (payload: Record<string, unknown>) => void): void {
    const payload = valid();
    mutate(payload);
    expect(() => parseBookingLifecyclePayload(payload)).toThrow(
      BookingLifecyclePayloadError,
    );
  }

  it('round-trips every transition the booking service writes', () => {
    const transitions: Array<[BookingStatus | null, BookingStatus]> = [
      [null, BookingStatus.Pending],
      [BookingStatus.Pending, BookingStatus.CancelledByUser],
      [BookingStatus.Pending, BookingStatus.Confirmed],
      [BookingStatus.Pending, BookingStatus.Rejected],
      [BookingStatus.Confirmed, BookingStatus.CancelledByAdmin],
    ];
    for (const [fromStatus, toStatus] of transitions) {
      const payload = toBookingLifecyclePayload(
        change({
          fromStatus,
          booking: { ...change().booking, status: toStatus },
        }),
      );
      expect(parseBookingLifecyclePayload(payload)).toEqual(payload);
    }
  });

  it('refuses a field outside the allowlist, so identity cannot leak onto the topic', () => {
    rejects((payload) => {
      payload.ownerUserId = '7';
    });
    rejects((payload) => {
      (payload.booking as Record<string, unknown>).reason = 'free text';
    });
  });

  it('refuses a missing field, wrong version, or malformed identifier', () => {
    rejects((payload) => {
      delete payload.previousStay;
    });
    rejects((payload) => {
      payload.schemaVersion = 2;
    });
    rejects((payload) => {
      payload.bookingId = 'not-a-ulid';
    });
    rejects((payload) => {
      payload.bookingVersion = 0;
    });
  });

  it('refuses statuses and transitions the contract does not define', () => {
    rejects((payload) => {
      payload.toStatus = 'ARCHIVED';
    });
    // Only creation may lack a prior status, and creation always lands on PENDING.
    rejects((payload) => {
      payload.fromStatus = null;
    });
    // An unchanged status is a stay change, which must say what the stay was.
    rejects((payload) => {
      payload.fromStatus = 'CONFIRMED';
    });
    // Transitions out of a terminal state, back to PENDING, or skipping the table.
    for (const [fromStatus, toStatus] of [
      ['REJECTED', 'CONFIRMED'],
      ['CANCELLED_BY_USER', 'PENDING'],
      ['CONFIRMED', 'REJECTED'],
      ['CONFIRMED', 'CANCELLED_BY_USER'],
    ]) {
      rejects((payload) => {
        payload.fromStatus = fromStatus;
        payload.toStatus = toStatus;
      });
    }
  });

  it('refuses a stay change on a terminal booking', () => {
    rejects((payload) => {
      payload.fromStatus = 'REJECTED';
      payload.toStatus = 'REJECTED';
      payload.previousStay = {
        roomId: '11',
        roomTypeId: '3',
        checkIn: '2026-10-09',
        checkOut: '2026-10-11',
      };
    });
  });

  it('refuses an identifier the database column could not store', () => {
    // Twenty digits pass the decimal pattern; this one is past BIGINT UNSIGNED.
    rejects((payload) => {
      (payload.booking as Record<string, unknown>).roomId =
        '18446744073709551616';
    });
    rejects((payload) => {
      (payload.booking as Record<string, unknown>).roomTypeId =
        '99999999999999999999';
    });
    // The maximum itself is storable.
    const payload = valid();
    (payload.booking as Record<string, unknown>).roomId =
      '18446744073709551615';
    expect(() => parseBookingLifecyclePayload(payload)).not.toThrow();
  });

  it('refuses an impossible stay, price, or currency', () => {
    rejects((payload) => {
      (payload.booking as Record<string, unknown>).checkOut = '2026-10-10';
    });
    rejects((payload) => {
      (payload.booking as Record<string, unknown>).checkIn = '2026-02-30';
    });
    rejects((payload) => {
      (payload.booking as { price: { amount: number } }).price.amount = -1;
    });
    rejects((payload) => {
      (payload.booking as { price: { currency: string } }).price.currency =
        'ZZZ';
    });
  });

  it('keeps payload values out of the error message', () => {
    const payload = valid();
    payload.bookingId = 'secret-looking-value';

    expect(() => parseBookingLifecyclePayload(payload)).toThrow(
      'Invalid booking lifecycle field: bookingId',
    );
  });
});
