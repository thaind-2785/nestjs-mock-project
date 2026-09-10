export interface BookingCreateInput {
  roomId: string;
  checkIn: string;
  checkOut: string;
}

export interface BookingCreateResponse {
  id: string;
  room: {
    id: string;
    roomNumber: string;
    roomType: { id: string; name: string };
  };
  checkIn: string;
  checkOut: string;
  nights: number;
  status: 'PENDING';
  price: { amount: number; currency: string };
  rejectionReason: null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
