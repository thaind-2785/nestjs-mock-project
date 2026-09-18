export enum BookingStatus {
  Pending = 'PENDING',
  Confirmed = 'CONFIRMED',
  Rejected = 'REJECTED',
  CancelledByUser = 'CANCELLED_BY_USER',
  CancelledByAdmin = 'CANCELLED_BY_ADMIN',
  Completed = 'COMPLETED',
}

export enum BookingActorType {
  User = 'USER',
  Admin = 'ADMIN',
  System = 'SYSTEM',
}
