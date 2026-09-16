import { isISO4217CurrencyCode } from 'class-validator';
import { BookingStatus } from '../bookings/entities/booking.enums';
import { decimalIdPattern } from '../common/constants/identifier.constants';

export const notificationEventTypes = [
  'booking.confirmed',
  'booking.rejected',
  'booking.changed',
  'booking.cancelled_by_admin',
] as const;

export type NotificationEventType = (typeof notificationEventTypes)[number];

export const notificationEventErrorCodes = {
  invalid: 'NOTIFICATION_EVENT_INVALID',
  unsupportedType: 'NOTIFICATION_EVENT_TYPE_UNSUPPORTED',
  unsupportedVersion: 'NOTIFICATION_EVENT_VERSION_UNSUPPORTED',
} as const;

export type NotificationEventErrorCode =
  (typeof notificationEventErrorCodes)[keyof typeof notificationEventErrorCodes];

/**
 * A stable, content-free error for the permanent-failure classifier in P5-T05.
 * Field paths are schema metadata; payload values never enter the message.
 */
export class NotificationEventError extends Error {
  constructor(
    readonly code: NotificationEventErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationEventError';
  }
}

export interface NotificationRoomSnapshot {
  id: string;
  roomNumber: string;
}

export interface NotificationPriceSnapshot {
  amount: number;
  currency: string;
}

export interface NotificationBookingSnapshot {
  room: NotificationRoomSnapshot;
  checkIn: string;
  checkOut: string;
  status: BookingStatus;
  price: NotificationPriceSnapshot;
}

export interface NotificationBookingSnapshotWithReason extends NotificationBookingSnapshot {
  reason: string;
}

export interface NotificationChangeEndpoint {
  roomId: string;
  checkIn: string;
  checkOut: string;
}

interface NotificationEventBase {
  schemaVersion: 1;
  bookingId: string;
  ownerUserId: string;
  bookingVersion: number;
}

export interface BookingConfirmedEvent extends NotificationEventBase {
  type: 'booking.confirmed';
  booking: NotificationBookingSnapshot;
}

export interface BookingRejectedEvent extends NotificationEventBase {
  type: 'booking.rejected';
  booking: NotificationBookingSnapshotWithReason & {
    status: BookingStatus.Rejected;
  };
}

export interface BookingChangedEvent extends NotificationEventBase {
  type: 'booking.changed';
  booking: NotificationBookingSnapshotWithReason & {
    status: BookingStatus.Pending | BookingStatus.Confirmed;
  };
  before: NotificationChangeEndpoint;
  after: NotificationChangeEndpoint;
}

export interface BookingCancelledByAdminEvent extends NotificationEventBase {
  type: 'booking.cancelled_by_admin';
  booking: NotificationBookingSnapshotWithReason & {
    status: BookingStatus.CancelledByAdmin;
  };
}

export type NotificationEvent =
  | BookingConfirmedEvent
  | BookingRejectedEvent
  | BookingChangedEvent
  | BookingCancelledByAdminEvent;

const publicBookingIdPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const basePayloadKeys = [
  'schemaVersion',
  'bookingId',
  'ownerUserId',
  'bookingVersion',
  'booking',
] as const;

const bookingKeys = ['room', 'checkIn', 'checkOut', 'status', 'price'] as const;

export function parseNotificationEvent(
  eventType: string,
  payload: unknown,
): NotificationEvent {
  if (!notificationEventTypes.includes(eventType as NotificationEventType)) {
    throw new NotificationEventError(
      notificationEventErrorCodes.unsupportedType,
      'Notification event type is unsupported.',
    );
  }
  const type = eventType as NotificationEventType;
  const value = requireRecord(payload, 'payload');
  if (
    typeof value.schemaVersion !== 'number' ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1
  ) {
    invalid('schemaVersion');
  }
  if (value.schemaVersion !== 1) {
    throw new NotificationEventError(
      notificationEventErrorCodes.unsupportedVersion,
      'Notification event schema version is unsupported.',
    );
  }

  requireExactKeys(
    value,
    type === 'booking.changed'
      ? [...basePayloadKeys, 'before', 'after']
      : basePayloadKeys,
    'payload',
  );

  const common = {
    schemaVersion: 1 as const,
    bookingId: requireString(
      value.bookingId,
      'bookingId',
      26,
      26,
      publicBookingIdPattern,
    ),
    ownerUserId: requireString(
      value.ownerUserId,
      'ownerUserId',
      1,
      20,
      decimalIdPattern,
    ),
    bookingVersion: requireSafeInteger(
      value.bookingVersion,
      'bookingVersion',
      1,
    ),
  };

  if (type === 'booking.confirmed') {
    return {
      type,
      ...common,
      booking: requireBookingSnapshot(
        value.booking,
        [BookingStatus.Confirmed],
        false,
      ),
    };
  }
  if (type === 'booking.rejected') {
    return {
      type,
      ...common,
      booking: requireBookingSnapshot(
        value.booking,
        [BookingStatus.Rejected],
        true,
      ) as BookingRejectedEvent['booking'],
    };
  }
  if (type === 'booking.cancelled_by_admin') {
    return {
      type,
      ...common,
      booking: requireBookingSnapshot(
        value.booking,
        [BookingStatus.CancelledByAdmin],
        true,
      ) as BookingCancelledByAdminEvent['booking'],
    };
  }

  const booking = requireBookingSnapshot(
    value.booking,
    [BookingStatus.Pending, BookingStatus.Confirmed],
    true,
  ) as BookingChangedEvent['booking'];
  const before = requireChangeEndpoint(value.before, 'before');
  const after = requireChangeEndpoint(value.after, 'after');
  if (
    after.roomId !== booking.room.id ||
    after.checkIn !== booking.checkIn ||
    after.checkOut !== booking.checkOut
  ) {
    invalid('after');
  }
  if (
    before.roomId === after.roomId &&
    before.checkIn === after.checkIn &&
    before.checkOut === after.checkOut
  ) {
    invalid('before');
  }
  return { type, ...common, booking, before, after };
}

function requireBookingSnapshot(
  input: unknown,
  expectedStatuses: readonly BookingStatus[],
  reasonRequired: boolean,
): NotificationBookingSnapshot | NotificationBookingSnapshotWithReason {
  const value = requireRecord(input, 'booking');
  requireExactKeys(
    value,
    reasonRequired ? [...bookingKeys, 'reason'] : bookingKeys,
    'booking',
  );
  const room = requireRecord(value.room, 'booking.room');
  requireExactKeys(room, ['id', 'roomNumber'], 'booking.room');
  const price = requireRecord(value.price, 'booking.price');
  requireExactKeys(price, ['amount', 'currency'], 'booking.price');

  const checkIn = requireHotelDate(value.checkIn, 'booking.checkIn');
  const checkOut = requireHotelDate(value.checkOut, 'booking.checkOut');
  if (checkIn >= checkOut) invalid('booking.checkOut');

  const status = requireEnum(value.status, 'booking.status', expectedStatuses);
  const snapshot: NotificationBookingSnapshot = {
    room: {
      id: requireString(room.id, 'booking.room.id', 1, 20, decimalIdPattern),
      roomNumber: requireString(
        room.roomNumber,
        'booking.room.roomNumber',
        1,
        50,
        undefined,
        true,
      ),
    },
    checkIn,
    checkOut,
    status,
    price: {
      amount: requireSafeInteger(price.amount, 'booking.price.amount', 0),
      currency: requireCurrency(price.currency),
    },
  };
  if (!reasonRequired) return snapshot;
  return {
    ...snapshot,
    reason: requireString(
      value.reason,
      'booking.reason',
      1,
      1_000,
      undefined,
      true,
    ),
  };
}

function requireChangeEndpoint(
  input: unknown,
  path: 'before' | 'after',
): NotificationChangeEndpoint {
  const value = requireRecord(input, path);
  requireExactKeys(value, ['roomId', 'checkIn', 'checkOut'], path);
  const checkIn = requireHotelDate(value.checkIn, `${path}.checkIn`);
  const checkOut = requireHotelDate(value.checkOut, `${path}.checkOut`);
  if (checkIn >= checkOut) invalid(`${path}.checkOut`);
  return {
    roomId: requireString(
      value.roomId,
      `${path}.roomId`,
      1,
      20,
      decimalIdPattern,
    ),
    checkIn,
    checkOut,
  };
}

function requireRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    invalid(path);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    invalid(path);
  }
}

function requireString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  pattern?: RegExp,
  requireTrimmed = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    hasUnsafeBodyControl(value) ||
    (requireTrimmed && value.trim() !== value) ||
    (pattern && !pattern.test(value))
  ) {
    invalid(path);
  }
  return value;
}

function hasUnsafeBodyControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code === 127 ||
      (code < 32 && code !== 9 && code !== 10 && code !== 13)
    ) {
      return true;
    }
  }
  return false;
}

function requireSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalid(path);
  }
  return value;
}

function requireCurrency(value: unknown): string {
  const currency = requireString(
    value,
    'booking.price.currency',
    3,
    3,
    /^[A-Z]{3}$/,
  );
  if (!isISO4217CurrencyCode(currency)) invalid('booking.price.currency');
  return currency;
}

function requireEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(path);
  return value as T;
}

function requireHotelDate(value: unknown, path: string): string {
  const date = requireString(
    value,
    path,
    10,
    10,
    /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/,
  );
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
  throw new NotificationEventError(
    notificationEventErrorCodes.invalid,
    `Invalid notification event field: ${path}`,
  );
}
