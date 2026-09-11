import { BookingActorType, BookingStatus } from './entities/booking.enums';
import {
  UserBookingHistoryResponse,
  UserBookingResponse,
} from './user-booking.types';

export interface AdminBookingOwner {
  id: string;
  email: string;
  displayName: string;
  status: string;
}

export interface AdminBookingResponse extends UserBookingResponse {
  owner: AdminBookingOwner;
}

export interface AdminBookingChangeHistoryResponse {
  actor: { id: string; displayName: string };
  from: { roomId: string; checkIn: string; checkOut: string };
  to: { roomId: string; checkIn: string; checkOut: string };
  reason: string;
  createdAt: string;
}

export interface AdminBookingDetailResponse extends AdminBookingResponse {
  history: UserBookingHistoryResponse[];
  changes: AdminBookingChangeHistoryResponse[];
}

export interface PaginatedAdminBookingsResponse {
  items: AdminBookingResponse[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminTransitionInput {
  actorUserId: string;
  bookingPublicId: string;
  reason?: string;
  requestId?: string;
}

export interface AdminTransitionResult {
  status: BookingStatus;
  actorType: BookingActorType;
}
