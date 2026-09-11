import { bookingsErrors } from './bookings.errors';

const quotedVersionPattern = /^"([1-9][0-9]{0,19})"$/;

export function parseBookingVersionHeader(value: string | undefined): string {
  if (value === undefined || value === '')
    throw bookingsErrors.versionRequired();
  const match = quotedVersionPattern.exec(value);
  if (!match) throw bookingsErrors.versionMalformed();
  return match[1];
}
