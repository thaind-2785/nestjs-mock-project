import {
  assertBookingDates,
  bookingCreateFingerprint,
  createMonotonicBookingId,
} from './booking-create.helpers';

describe('booking create helpers', () => {
  it('creates ordered 26-character ULIDs within one millisecond', () => {
    const first = createMonotonicBookingId(1_800_000_000_000);
    const second = createMonotonicBookingId(1_800_000_000_000);

    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
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
