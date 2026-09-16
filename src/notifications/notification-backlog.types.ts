import type { OutboxEventStatus } from '../bookings/entities/booking.enums';
import type { EmailDeliveryStatus } from './entities/notification.enums';

/**
 * One outbox group, restricted to the event types this worker delivers.
 *
 * `oldestAvailableAgeMs` is reported for `PENDING` only, where it is how long the
 * most overdue event has been waiting. Every other status reports zero: for a claimed
 * or terminal row `available_at` is the moment it became due, which says nothing
 * about whether it is progressing, and an unbounded age on a `PROCESSED` group is
 * noise that grows forever. Stuck leases are reported separately by `LeaseBacklog`.
 */
export interface OutboxBacklogEntry {
  eventType: string;
  status: OutboxEventStatus;
  count: number;
  oldestAvailableAgeMs: number;
}

/**
 * Claims whose lease has expired and that no dispatcher has recovered yet.
 *
 * A non-zero count that keeps growing is the signature of "no relay is polling",
 * which is otherwise invisible: the events are `PROCESSING`, so they are absent from
 * the pending backlog while nothing is moving them.
 */
export interface LeaseBacklog {
  expiredCount: number;
  oldestExpiredAgeMs: number;
}

/** Delivery counts carry the template and the result, never a recipient. */
export interface DeliveryBacklogEntry {
  templateKey: string;
  status: EmailDeliveryStatus;
  count: number;
}

export interface QueueBacklogCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface NotificationBacklogSnapshot {
  outbox: OutboxBacklogEntry[];
  leases: LeaseBacklog;
  deliveries: DeliveryBacklogEntry[];
}

export interface OutboxBacklogRow {
  eventType: string;
  status: OutboxEventStatus;
  count: string | number;
  oldestAvailableAgeUs: string | number | null;
}

export interface LeaseBacklogRow {
  expiredCount: string | number;
  oldestExpiredAgeUs: string | number | null;
}

export interface DeliveryBacklogRow {
  templateKey: string;
  status: EmailDeliveryStatus;
  count: string | number;
}
