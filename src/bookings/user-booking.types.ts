import { BookingActorType, BookingStatus } from './entities/booking.enums';

export interface UserBookingResponse {
  id: string;
  room: {
    id: string;
    roomNumber: string;
    roomType: { id: string; name: string };
  };
  checkIn: string;
  checkOut: string;
  nights: number;
  status: BookingStatus;
  price: { amount: number; currency: string };
  rejectionReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserBookingHistoryResponse {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  actorType: BookingActorType;
  actor?: { id: string; displayName: string };
  reason: string | null;
  createdAt: string;
}

export interface UserBookingDetailResponse extends UserBookingResponse {
  history: UserBookingHistoryResponse[];
}

export interface PaginatedUserBookingsResponse {
  items: UserBookingResponse[];
  page: number;
  pageSize: number;
  total: number;
}
