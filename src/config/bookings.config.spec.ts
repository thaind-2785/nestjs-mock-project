import { createBookingsConfiguration } from './bookings.config';
import { validateEnvironment } from './environment.validation';

describe('createBookingsConfiguration', () => {
  it('maps the accepted Phase 4 defaults', () => {
    expect(createBookingsConfiguration(validateEnvironment({}))).toEqual({
      hotelTimezone: 'Asia/Ho_Chi_Minh',
      createRateLimit: { max: 10, windowSeconds: 60 },
    });
  });

  it('maps explicit bounded values', () => {
    expect(
      createBookingsConfiguration(
        validateEnvironment({
          HOTEL_TIMEZONE: 'America/New_York',
          BOOKING_CREATE_RATE_LIMIT_MAX: '4',
          BOOKING_CREATE_RATE_LIMIT_WINDOW_SECONDS: '120',
        }),
      ),
    ).toEqual({
      hotelTimezone: 'America/New_York',
      createRateLimit: { max: 4, windowSeconds: 120 },
    });
  });
});
