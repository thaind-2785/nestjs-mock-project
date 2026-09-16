import type { DeliveryPreparationErrorCode } from './delivery-preparation.types';

export class DeliveryPreparationError extends Error {
  constructor(readonly code: DeliveryPreparationErrorCode) {
    super(code);
    this.name = 'DeliveryPreparationError';
  }
}
