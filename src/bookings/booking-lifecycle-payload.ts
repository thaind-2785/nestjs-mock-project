import { isISO4217CurrencyCode } from 'class-validator';
import {
  decimalIdPattern,
  maxUnsignedBigint,
} from '../common/constants/identifier.constants';
import {
  bookingLifecycleErrorCodes,
  bookingLifecycleEventSchemaVersion,
  bookingLifecycleTransitions,
} from './booking-lifecycle-event.constants';
import type {
  BookingLifecycleChange,
  BookingLifecyclePayload,
  BookingLifecycleStay,
} from './booking-lifecycle-event.types';
import { BookingStatus } from './entities/booking.enums';

const publicBookingIdPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const hotelDatePattern = /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/;
const bookingStatuses: readonly string[] = Object.values(BookingStatus);
const payloadKeys = [
  'schemaVersion',
  'bookingId',
  'bookingVersion',
  'fromStatus',
  'toStatus',
  'booking',
  'previousStay',
];
const stayKeys = ['roomId', 'roomTypeId', 'checkIn', 'checkOut'];

/** Builds the payload a booking transaction writes. */
export function toBookingLifecyclePayload(
  change: BookingLifecycleChange,
): BookingLifecyclePayload {
  const { booking, room } = change;
  return {
    schemaVersion: bookingLifecycleEventSchemaVersion,
    bookingId: booking.publicId,
    bookingVersion: Number(booking.version),
    fromStatus: change.fromStatus,
    toStatus: booking.status,
    booking: {
      roomId: room.id,
      roomTypeId: room.roomTypeId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      price: {
        amount: Number(booking.priceAmount),
        currency: booking.currency,
      },
    },
    previousStay: change.previousStay ?? null,
  };
}

/**
 * A stable, content-free error: field paths are schema metadata, and payload values
 * never enter the message.
 */
export class BookingLifecyclePayloadError extends Error {
  readonly code = bookingLifecycleErrorCodes.invalid;

  constructor(path: string) {
    super(`Invalid booking lifecycle field: ${path}`);
    this.name = 'BookingLifecyclePayloadError';
  }
}

/**
 * The relay's gate on what it publishes. The writer is this codebase, so a failure
 * here is a programming error; checking anyway is what keeps a `.v1` consumer from
 * receiving a shape `.v1` never promised. Exact keys, so a field added to the builder
 * without a schema decision fails here rather than leaking onto the topic.
 */
export function parseBookingLifecyclePayload(
  input: unknown,
): BookingLifecyclePayload {
  const value = requireRecord(input, 'payload', payloadKeys);
  if (value.schemaVersion !== bookingLifecycleEventSchemaVersion) {
    invalid('schemaVersion');
  }
  const bookingId = requireString(
    value.bookingId,
    'bookingId',
    publicBookingIdPattern,
  );
  const bookingVersion = value.bookingVersion;
  if (
    typeof bookingVersion !== 'number' ||
    !Number.isSafeInteger(bookingVersion) ||
    bookingVersion < 1
  ) {
    invalid('bookingVersion');
  }
  const fromStatus =
    value.fromStatus === null
      ? null
      : requireStatus(value.fromStatus, 'fromStatus');
  const toStatus = requireStatus(value.toStatus, 'toStatus');

  const booking = requireRecord(value.booking, 'booking', [
    ...stayKeys,
    'price',
  ]);
  const price = requireRecord(booking.price, 'booking.price', [
    'amount',
    'currency',
  ]);
  const amount = price.amount;
  if (
    typeof amount !== 'number' ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    invalid('booking.price.amount');
  }
  const currency = requireString(
    price.currency,
    'booking.price.currency',
    /^[A-Z]{3}$/,
  );
  if (!isISO4217CurrencyCode(currency)) invalid('booking.price.currency');

  const previousStay =
    value.previousStay === null
      ? null
      : requireStay(value.previousStay, 'previousStay');
  // The pair must be one `.v1` defines, and a stay change - the only change that keeps
  // its status - is the only one that says what the stay was.
  if (!bookingLifecycleTransitions.has(`${fromStatus ?? 'null'}>${toStatus}`)) {
    invalid('toStatus');
  }
  if (previousStay !== null && fromStatus !== toStatus) invalid('previousStay');
  if (previousStay === null && fromStatus === toStatus) invalid('toStatus');

  return {
    schemaVersion: bookingLifecycleEventSchemaVersion,
    bookingId,
    bookingVersion,
    fromStatus,
    toStatus,
    booking: {
      ...requireStay(
        {
          roomId: booking.roomId,
          roomTypeId: booking.roomTypeId,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
        'booking',
      ),
      price: { amount, currency },
    },
    previousStay,
  };
}

function requireStay(input: unknown, path: string): BookingLifecycleStay {
  const value = requireRecord(input, path, stayKeys);
  const checkIn = requireHotelDate(value.checkIn, `${path}.checkIn`);
  const checkOut = requireHotelDate(value.checkOut, `${path}.checkOut`);
  if (checkIn >= checkOut) invalid(`${path}.checkOut`);
  return {
    roomId: requireStoredId(value.roomId, `${path}.roomId`),
    roomTypeId: requireStoredId(value.roomTypeId, `${path}.roomTypeId`),
    checkIn,
    checkOut,
  };
}

/**
 * A decimal ID a MySQL `BIGINT UNSIGNED` can hold. The pattern alone admits twenty-digit
 * values past the column's maximum, which a consumer would otherwise accept and then
 * fail to store - a message that parses but can never be applied, holding its partition.
 */
function requireStoredId(value: unknown, path: string): string {
  const id = requireString(value, path, decimalIdPattern);
  if (BigInt(id) > maxUnsignedBigint) invalid(path);
  return id;
}

function requireRecord(
  input: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid(path);
  }
  const value = input as Record<string, unknown>;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(path);
  }
  return value;
}

function requireString(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(path);
  return value;
}

function requireStatus(value: unknown, path: string): BookingStatus {
  if (typeof value !== 'string' || !bookingStatuses.includes(value)) {
    invalid(path);
  }
  return value as BookingStatus;
}

function requireHotelDate(value: unknown, path: string): string {
  const date = requireString(value, path, hotelDatePattern);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    invalid(path);
  }
  return date;
}

function invalid(path: string): never {
  throw new BookingLifecyclePayloadError(path);
}
