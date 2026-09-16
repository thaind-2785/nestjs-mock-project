import type { OutboxEventStatus } from '../bookings/entities/booking.enums';
import type { EmailDeliveryStatus } from './entities/notification.enums';
import type { redriveOutcomeCodes } from './notification-redrive.constants';

export type RedriveOutcomeCode =
  (typeof redriveOutcomeCodes)[keyof typeof redriveOutcomeCodes];

export interface RedriveRequest {
  outboxEventId: string;
  /** Operator justification. Its length is audited; its text never is. */
  reason: string;
}

export interface RedriveResult {
  applied: boolean;
  code: RedriveOutcomeCode;
  outboxEventId: string;
  /** The state that refused the redrive, or the state it was applied to. */
  observedEventStatus: OutboxEventStatus | null;
  deliveriesReset: number;
}

/** Only the status is read; the lock is what the SELECT is really for. */
export interface LockedOutboxRow {
  status: OutboxEventStatus;
}

export interface LockedDeliveryRow {
  status: EmailDeliveryStatus;
}
