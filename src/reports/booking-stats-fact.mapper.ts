import type { ReceivedBookingLifecycleEvent } from '../bookings/booking-lifecycle-event.types';
import type { BookingStatsFactRow } from './booking-stats.types';

/** A checked lifecycle event as the read model stores it: the state after the change. */
export function toBookingStatsFact(
  event: ReceivedBookingLifecycleEvent,
): BookingStatsFactRow {
  const { payload } = event;
  return {
    bookingPublicId: payload.bookingId,
    bookingVersion: payload.bookingVersion,
    status: payload.toStatus,
    roomId: payload.booking.roomId,
    roomTypeId: payload.booking.roomTypeId,
    checkIn: payload.booking.checkIn,
    checkOut: payload.booking.checkOut,
    priceAmount: payload.booking.price.amount,
    currency: payload.booking.price.currency,
    lastEventId: event.eventId,
    lastOccurredAt: event.occurredAt,
  };
}
