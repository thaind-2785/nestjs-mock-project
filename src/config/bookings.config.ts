import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

export interface BookingsConfiguration {
  hotelTimezone: string;
  createRateLimit: {
    max: number;
    windowSeconds: number;
  };
}

export function createBookingsConfiguration(
  environment: EnvironmentVariables,
): BookingsConfiguration {
  return {
    hotelTimezone: environment.HOTEL_TIMEZONE,
    createRateLimit: {
      max: environment.BOOKING_CREATE_RATE_LIMIT_MAX,
      windowSeconds: environment.BOOKING_CREATE_RATE_LIMIT_WINDOW_SECONDS,
    },
  };
}

export const bookingsConfig = registerAs('bookings', () =>
  createBookingsConfiguration(validateEnvironment(process.env)),
);
