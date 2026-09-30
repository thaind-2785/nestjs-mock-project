import { isUUID } from 'class-validator';
import {
  bookingLifecycleEventSchemaVersion,
  bookingLifecycleEventType,
  bookingLifecycleHeaders,
} from './booking-lifecycle-event.constants';
import type {
  BookingLifecyclePayload,
  ReceivedBookingLifecycleEvent,
} from './booking-lifecycle-event.types';
import {
  BookingLifecyclePayloadError,
  parseBookingLifecyclePayload,
} from './booking-lifecycle-payload';
import type {
  BookingLifecycleMessage,
  ClaimedLifecycleRow,
} from './booking-lifecycle-relay.types';

/**
 * Wraps a validated payload in the published envelope.
 *
 * `occurredAt` is the outbox row's `created_at`: when the booking transaction wrote the
 * row, not when it committed. It comes from MySQL, so every event carries the database's
 * UTC clock rather than whichever process published it.
 * The key is the booking, which is what keeps one booking's events on one partition.
 */
export function toBookingLifecycleMessage(
  row: ClaimedLifecycleRow,
  payload: BookingLifecyclePayload,
): BookingLifecycleMessage {
  const occurredAt = row.createdAt.toISOString();
  return {
    key: payload.bookingId,
    value: JSON.stringify({
      eventId: row.id,
      eventType: bookingLifecycleEventType,
      occurredAt,
      ...payload,
    }),
    timestampMs: row.createdAt.getTime(),
    headers: {
      [bookingLifecycleHeaders.eventId]: row.id,
      [bookingLifecycleHeaders.eventType]: bookingLifecycleEventType,
      [bookingLifecycleHeaders.schemaVersion]: String(
        bookingLifecycleEventSchemaVersion,
      ),
    },
  };
}

const envelopeKeys = new Set(['eventId', 'eventType', 'occurredAt']);

/** The years a MySQL `DATETIME` accepts; `occurredAt` is stored in one. */
const storableYears = { min: 1000, max: 9999 } as const;

/**
 * The consumer side of the same contract: a published value back into a checked event.
 *
 * It lives beside the envelope builder so the two cannot drift - a consumer that parsed
 * its own idea of `.v1` would accept what the relay never publishes, or refuse what it
 * does. The envelope is separated first and the remainder must be exactly the payload
 * `parseBookingLifecyclePayload` accepts, so an unknown field anywhere is a refusal.
 */
export function parseBookingLifecycleMessage(
  value: string | null,
): ReceivedBookingLifecycleEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value ?? '') as unknown;
  } catch {
    throw new BookingLifecyclePayloadError('value');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new BookingLifecyclePayloadError('value');
  }
  const record = decoded as Record<string, unknown>;
  const { eventId, eventType, occurredAt } = record;
  if (typeof eventId !== 'string' || !isUUID(eventId)) {
    throw new BookingLifecyclePayloadError('eventId');
  }
  if (eventType !== bookingLifecycleEventType) {
    throw new BookingLifecyclePayloadError('eventType');
  }
  const occurred =
    typeof occurredAt === 'string' ? new Date(occurredAt) : undefined;
  if (
    occurred === undefined ||
    Number.isNaN(occurred.valueOf()) ||
    occurred.toISOString() !== occurredAt ||
    occurred.getUTCFullYear() < storableYears.min ||
    occurred.getUTCFullYear() > storableYears.max
  ) {
    throw new BookingLifecyclePayloadError('occurredAt');
  }
  const payload = Object.fromEntries(
    Object.entries(record).filter(([key]) => !envelopeKeys.has(key)),
  );
  return {
    eventId,
    occurredAt: occurred,
    payload: parseBookingLifecyclePayload(payload),
  };
}
