import {
  bookingLifecycleEventSchemaVersion,
  bookingLifecycleEventType,
  bookingLifecycleHeaders,
} from './booking-lifecycle-event.constants';
import type { BookingLifecyclePayload } from './booking-lifecycle-event.types';
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
