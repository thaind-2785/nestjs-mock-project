import { BookingStatus } from './entities/booking.enums';

/**
 * The lifecycle stream's outbox family. It is a durable contract: rows carrying it
 * exist in `outbox_events` as soon as the stream is enabled, so renaming it is a
 * migration rather than a refactor. It deliberately does not start with `booking.`,
 * so nobody reading an allowlist mistakes it for one of the four mail intents.
 */
export const bookingLifecycleEventType = 'booking-lifecycle.recorded';

/**
 * The relay's claim allowlist. Like the export family's, it reaches the claiming SQL
 * rather than filtering a claimed batch, so the relay never holds a lease on a mail or
 * export row.
 */
export const bookingLifecycleEventTypes = [bookingLifecycleEventType] as const;

/** The schema version carried by every payload of this family. */
export const bookingLifecycleEventSchemaVersion = 1;

/** Kafka header names; consumers deduplicate on `event-id`. */
export const bookingLifecycleHeaders = {
  eventId: 'event-id',
  eventType: 'event-type',
  schemaVersion: 'schema-version',
} as const;

export const bookingLifecycleErrorCodes = {
  invalid: 'BOOKING_STREAM_EVENT_INVALID',
  publishFailed: 'BOOKING_STREAM_PUBLISH_FAILED',
} as const;

/**
 * Retry jitter above the base delay, so a broker coming back does not receive every
 * waiting batch in the same millisecond. The same ratio the mail family uses.
 */
export const bookingLifecycleBackoffJitterRatio = 0.2;

/** The error name a publish that outlived its bound rejects with. */
export const bookingLifecyclePublishTimeoutName =
  'BookingLifecyclePublishTimeout';

/**
 * Every `from -> to` pair `.v1` defines (`SPEC-012` transition table), keyed as
 * `from>to` with `null` for creation. A stay change keeps its status and is allowed
 * only on a live booking. The parser checks against this set, so a writer bug cannot
 * put an undefined transition on the topic.
 */
export const bookingLifecycleTransitions: ReadonlySet<string> = new Set(
  (
    [
      [null, BookingStatus.Pending],
      [BookingStatus.Pending, BookingStatus.CancelledByUser],
      [BookingStatus.Pending, BookingStatus.Confirmed],
      [BookingStatus.Pending, BookingStatus.Rejected],
      [BookingStatus.Pending, BookingStatus.CancelledByAdmin],
      [BookingStatus.Confirmed, BookingStatus.CancelledByAdmin],
      [BookingStatus.Pending, BookingStatus.Pending],
      [BookingStatus.Confirmed, BookingStatus.Confirmed],
    ] as const
  ).map(([from, to]) => `${from ?? 'null'}>${to}`),
);
