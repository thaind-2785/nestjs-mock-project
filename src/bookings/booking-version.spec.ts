import { parseBookingVersionHeader } from './booking-version';

describe('parseBookingVersionHeader', () => {
  it('accepts one strong positive decimal version', () => {
    expect(parseBookingVersionHeader('"42"')).toBe('42');
  });

  it.each([
    [undefined, 'BOOKING_VERSION_REQUIRED'],
    ['', 'BOOKING_VERSION_REQUIRED'],
    ['42', 'BOOKING_VERSION_MALFORMED'],
    ['W/"42"', 'BOOKING_VERSION_MALFORMED'],
    ['"0"', 'BOOKING_VERSION_MALFORMED'],
  ])('rejects %p with %s', (value, errorCode) => {
    try {
      parseBookingVersionHeader(value);
      throw new Error('expected booking version parsing to fail');
    } catch (error) {
      expect(error).toMatchObject({ errorCode });
    }
  });
});
