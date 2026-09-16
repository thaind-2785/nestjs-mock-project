export interface DeliveryResultKey {
  outboxEventId: string;
  claimToken: string;
  attempt: number;
  /** Absent when the payload never parsed far enough to create a delivery row. */
  deliveryId?: string;
}

export interface DeliverySentInput extends DeliveryResultKey {
  providerMessageId: string | null;
}

export interface DeliveryRetryInput extends DeliveryResultKey {
  retryInMs: number;
  errorCode: string;
}

export interface DeliveryFailureInput extends DeliveryResultKey {
  errorCode: string;
}
