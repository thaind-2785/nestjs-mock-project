import { BookingStatus } from './entities/booking.enums';

/**
 * The one room-wide confirmed-overlap comparison. Booking approval, admin edits,
 * and public availability must answer this question identically, so all three
 * build their query from here instead of restating the comparison: a read that
 * drifted from the write would either advertise a room that cannot be booked or
 * hide one that can.
 *
 * Checkout is exclusive, so the half-open `<`/`>` pair deliberately lets one stay
 * check out on the day another checks in. Only `CONFIRMED` blocks: pending
 * requests are not yet promises, and terminal bookings never block again.
 *
 * The caller supplies its own room correlation and self-exclusion, because an
 * availability read correlates to a room column while a booking write binds a
 * locked room ID.
 */
export function confirmedOverlapCondition(bookingAlias: string): string {
  return (
    `${bookingAlias}.status = :overlapStatus` +
    ` AND ${bookingAlias}.check_in < :overlapCheckOut` +
    ` AND ${bookingAlias}.check_out > :overlapCheckIn`
  );
}

export interface ConfirmedOverlapParameters {
  overlapStatus: BookingStatus;
  overlapCheckIn: string;
  overlapCheckOut: string;
}

export function confirmedOverlapParameters(stay: {
  readonly checkIn: string;
  readonly checkOut: string;
}): ConfirmedOverlapParameters {
  return {
    overlapStatus: BookingStatus.Confirmed,
    overlapCheckIn: stay.checkIn,
    overlapCheckOut: stay.checkOut,
  };
}
