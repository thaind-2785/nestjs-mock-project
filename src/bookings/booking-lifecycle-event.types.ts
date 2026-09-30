import type { BookingStatus } from './entities/booking.enums';

/** Where and when a stay is, without who is staying. */
export interface BookingLifecycleStay {
  roomId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
}

export interface BookingLifecyclePrice {
  amount: number;
  currency: string;
}

export interface BookingLifecycleSnapshot extends BookingLifecycleStay {
  price: BookingLifecyclePrice;
}

/**
 * The outbox payload, which is also the published value minus the envelope the relay
 * adds. An explicit allowlist: no user ID, email, name, or free-text reason, so the
 * topic never becomes a second store of personal data (`ADR-0012`).
 */
export interface BookingLifecyclePayload {
  schemaVersion: 1;
  bookingId: string;
  /** The booking's version after this change; unique per booking and its order. */
  bookingVersion: number;
  /** `null` only for creation. Equal to `toStatus` for a stay change. */
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  booking: BookingLifecycleSnapshot;
  /** Present only for an admin room/date change: the stay before it. */
  previousStay: BookingLifecycleStay | null;
}

/** What a booking transaction hands the recorder after its own writes. */
export interface BookingLifecycleChange {
  booking: {
    publicId: string;
    version: string;
    status: BookingStatus;
    checkIn: string;
    checkOut: string;
    priceAmount: string;
    currency: string;
  };
  room: { id: string; roomTypeId: string };
  fromStatus: BookingStatus | null;
  previousStay?: BookingLifecycleStay;
}

/** A published message after the consumer side has checked it against `.v1`. */
export interface ReceivedBookingLifecycleEvent {
  eventId: string;
  occurredAt: Date;
  payload: BookingLifecyclePayload;
}
