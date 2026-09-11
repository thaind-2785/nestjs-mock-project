import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  assertBookingDates,
  bookingCreateFingerprint,
  bookingPublicIdPattern,
  createMonotonicBookingId,
} from './booking-create.helpers';
import { BookingIdParamDto } from './dto/booking-id-param.dto';

describe('booking create helpers', () => {
  it('creates ordered 26-character ULIDs within one millisecond', () => {
    const first = createMonotonicBookingId(1_800_000_000_000);
    const second = createMonotonicBookingId(1_800_000_000_000);

    expect(first).toMatch(bookingPublicIdPattern);
    expect(second > first).toBe(true);
  });

  it('only ever emits a canonical leading character', () => {
    // Ten base32 characters carry 50 bits while the timestamp is 48, so the
    // leading character is bounded by 7 for every representable millisecond.
    for (const timestamp of [0, 1, 1_800_000_000_000, 2 ** 48 - 1]) {
      const identifier = createMonotonicBookingId(timestamp);
      expect(identifier).toHaveLength(26);
      expect(identifier).toMatch(bookingPublicIdPattern);
    }
  });

  it('rejects a 26-character value the generator could never produce', () => {
    // `8` in the leading position encodes a timestamp past 2^48 ms. Accepting it
    // would turn an impossible identifier into a misleading not-found lookup.
    const overflow = `8${'0'.repeat(25)}`;
    expect(overflow).toHaveLength(26);
    expect(overflow).not.toMatch(bookingPublicIdPattern);
    expect(
      validateSync(
        plainToInstance(BookingIdParamDto, { bookingId: overflow }),
      ).map((error) => error.property),
    ).toEqual(['bookingId']);
    expect(
      validateSync(
        plainToInstance(BookingIdParamDto, {
          bookingId: createMonotonicBookingId(1_800_000_000_001),
        }),
      ),
    ).toEqual([]);
  });

  it('fingerprints the canonical booking identity and body', () => {
    const input = {
      roomId: '42',
      checkIn: '2026-10-01',
      checkOut: '2026-10-04',
    };
    expect(bookingCreateFingerprint('7', input)).toBe(
      bookingCreateFingerprint('7', { ...input }),
    );
    expect(bookingCreateFingerprint('7', input)).not.toBe(
      bookingCreateFingerprint('7', { ...input, roomId: '43' }),
    );
  });

  it.each([
    [{ checkIn: '2026-10-04', checkOut: '2026-10-04' }],
    [{ checkIn: '2026-02-29', checkOut: '2026-03-01' }],
    [{ checkIn: '2026-13-01', checkOut: '2026-13-02' }],
  ])('rejects invalid hotel date ranges', (input) => {
    expect(assertBookingDates(input, 'Asia/Ho_Chi_Minh')).toBe(0);
  });

  it('calculates nights for a future valid stay', () => {
    expect(
      assertBookingDates(
        { checkIn: '2099-10-01', checkOut: '2099-10-04' },
        'Asia/Ho_Chi_Minh',
      ),
    ).toBe(3);
  });
});
