export enum EmailDeliveryStatus {
  Pending = 'PENDING',
  Sent = 'SENT',
  Failed = 'FAILED',
}

/**
 * The locale a delivery was rendered in, snapshotted per record. Changing the
 * deployment default must not reinterpret mail that has already been composed.
 */
export enum EmailDeliveryLocale {
  English = 'en',
  Vietnamese = 'vi',
}
