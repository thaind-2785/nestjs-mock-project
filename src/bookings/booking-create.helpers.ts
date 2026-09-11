import { createHash, randomBytes } from 'node:crypto';
import { BookingCreateInput } from './booking-create.types';

const ulidAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The canonical form this generator can actually emit. Ten Crockford base32
 * characters carry 50 bits, but a ULID timestamp is 48, so the leading character
 * is the top two timestamp bits padded with three zeros and can never exceed `7`.
 * Accepting `8`-`Z` there would let a 130-bit value through validation only to
 * become a misleading not-found lookup, so the route pattern and the generator
 * agree here rather than in two places.
 */
export const bookingPublicIdPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ulidRandomMaximum = (1n << 80n) - 1n;
let lastTimestamp = -1;
let lastRandom = 0n;

export function createMonotonicBookingId(now = Date.now()): string {
  if (now > lastTimestamp) {
    lastTimestamp = now;
    lastRandom = BigInt(`0x${randomBytes(10).toString('hex')}`);
  } else {
    if (lastRandom === ulidRandomMaximum) {
      throw new Error('ULID random component exhausted in one millisecond');
    }
    lastRandom += 1n;
  }
  return `${encodeUlidPart(BigInt(lastTimestamp), 10)}${encodeUlidPart(lastRandom, 16)}`;
}

export function bookingCreateFingerprint(
  actorUserId: string,
  input: BookingCreateInput,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        operation: 'BOOKING_CREATE',
        actorUserId,
        roomId: input.roomId,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
      }),
    )
    .digest('hex');
}

export function assertBookingDates(
  input: Pick<BookingCreateInput, 'checkIn' | 'checkOut'>,
  hotelTimezone: string,
): number {
  const checkIn = parseHotelDate(input.checkIn);
  const checkOut = parseHotelDate(input.checkOut);
  if (checkIn === null || checkOut === null || checkIn >= checkOut) return 0;
  const today = hotelDateToday(hotelTimezone);
  if (input.checkIn < today) return 0;
  return Math.round((checkOut - checkIn) / 86_400_000);
}

function parseHotelDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return date.toISOString().slice(0, 10) === value ? date.getTime() : null;
}

function hotelDateToday(timeZone: string): string {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    values.find((value) => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function encodeUlidPart(value: bigint, length: number): string {
  let encoded = '';
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    encoded = ulidAlphabet[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}
