import type { PreparedNotification } from './delivery-preparation.types';

export type DeliveryOutcome = 'sent' | 'retry' | 'failed' | 'skipped';

export interface ClaimedWork {
  prepared: PreparedNotification;
}
