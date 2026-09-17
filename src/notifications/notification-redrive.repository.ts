import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from '../bookings/entities/booking.enums';
import { EmailDeliveryStatus } from './entities/notification.enums';
import { redriveOutcomeCodes } from './notification-redrive.constants';
import { SendAttemptRepository } from './send-attempt.repository';
import { notificationEventTypes } from './notification-event';
import type {
  LockedDeliveryRow,
  LockedOutboxRow,
  RedriveRequest,
  RedriveResult,
} from './notification-redrive.types';

const notificationEventTypePlaceholders = notificationEventTypes
  .map(() => '?')
  .join(', ');

/**
 * Returns one terminally failed event to the pipeline, and refuses every other state.
 *
 * The refusals are the feature. `PENDING` and `PROCESSING` are already on their way
 * and a second copy would be a second message; `PROCESSED` succeeded; and a delivery
 * that reads `SENT` means the provider accepted the mail whatever the event says, so
 * redriving it would mail the guest twice to fix a record. Only a `FAILED` event with
 * no `SENT` delivery is genuinely stuck.
 *
 * Locks are taken outbox-first and delivery-second, the order
 * `DeliveryResultRepository` fixes for the whole module. An operator running this
 * beside a live worker takes the same path a worker does, so the two serialize rather
 * than deadlock.
 */
@Injectable()
export class NotificationRedriveRepository {
  constructor(private readonly sendAttempts: SendAttemptRepository) {}

  async redrive(
    manager: EntityManager,
    request: RedriveRequest,
  ): Promise<RedriveResult> {
    const event = await this.lockEvent(manager, request.outboxEventId);
    if (!event) {
      return this.refuse(request, redriveOutcomeCodes.eventNotFound, null);
    }
    if (event.status !== OutboxEventStatus.Failed) {
      // Two operators redriving the same event serialize here: the second waits on
      // the first's row lock and then reads the PENDING the first committed.
      return this.refuse(
        request,
        redriveOutcomeCodes.eventNotFailed,
        event.status,
      );
    }

    const deliveries = await this.lockDeliveries(
      manager,
      request.outboxEventId,
    );
    if (deliveries.some((row) => row.status === EmailDeliveryStatus.Sent)) {
      return this.refuse(
        request,
        redriveOutcomeCodes.deliveryAlreadySent,
        event.status,
      );
    }

    // A delivery reading FAILED is not proof the provider refused the mail. A worker
    // that lost its claim after an acceptance writes no delivery state at all, so a
    // later permanent failure can mark FAILED a message the guest already has. The
    // append-only acceptance record is the only durable evidence that knows. This
    // check protects an operator-triggered redrive when the evidence already exists;
    // workers do not consult it before automatic recovery, and an acceptance insert
    // can race this deliberately non-locking read (documented in the runbook).
    if (!request.allowDuplicate) {
      const accepted = await this.sendAttempts.countAccepted(
        manager,
        request.outboxEventId,
      );
      if (accepted > 0) {
        return this.refuse(
          request,
          redriveOutcomeCodes.providerAlreadyAccepted,
          event.status,
        );
      }
    }

    // Asserted rather than assumed. The `FOR UPDATE` above makes a zero here
    // unreachable today, but a redrive that reported success while changing nothing
    // would be the worst possible failure of this command: the operator believes the
    // guest will be mailed and walks away.
    const eventsReset = await this.resetEvent(manager, request.outboxEventId);
    if (eventsReset === 0) {
      return this.refuse(
        request,
        redriveOutcomeCodes.eventNotFailed,
        event.status,
      );
    }
    const deliveriesReset = await this.resetDeliveries(
      manager,
      request.outboxEventId,
    );
    return {
      applied: true,
      code: redriveOutcomeCodes.redriven,
      outboxEventId: request.outboxEventId,
      observedEventStatus: event.status,
      deliveriesReset,
    };
  }

  /**
   * Scoped to the mail families, so an operator who pastes an export job's outbox id
   * into the redrive CLI gets `EVENT_NOT_FOUND` rather than a `PENDING` export event
   * with its attempts reset and no delivery rows to match it.
   */
  private async lockEvent(
    manager: EntityManager,
    id: string,
  ): Promise<LockedOutboxRow | undefined> {
    const rows: LockedOutboxRow[] = await manager.query(
      `SELECT status FROM outbox_events
       WHERE id = ? AND event_type IN (${notificationEventTypePlaceholders})
       FOR UPDATE`,
      [id, ...notificationEventTypes],
    );
    return rows[0];
  }

  private async lockDeliveries(
    manager: EntityManager,
    outboxEventId: string,
  ): Promise<LockedDeliveryRow[]> {
    const rows: LockedDeliveryRow[] = await manager.query(
      `SELECT status FROM email_deliveries WHERE outbox_event_id = ? FOR UPDATE`,
      [outboxEventId],
    );
    return rows;
  }

  /**
   * `attempts` returns to zero because it is the delivery budget, not history. An
   * event reaches `FAILED` with its budget spent, so a redrive that preserved the
   * count would hand the worker an event it must immediately fail again - a CLI that
   * reports success and changes nothing. The history an operator actually needs is
   * kept: `last_error_code` stays on the row to say why it failed, and the delivery's
   * cumulative `attempts` is untouched below.
   */
  private async resetEvent(
    manager: EntityManager,
    id: string,
  ): Promise<number> {
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE outbox_events
       SET status = ?,
           available_at = NOW(6),
           failed_at = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           locked_by = NULL,
           attempts = 0
       WHERE id = ?
         AND event_type IN (${notificationEventTypePlaceholders})
         AND status = ?`,
      [
        OutboxEventStatus.Pending,
        id,
        ...notificationEventTypes,
        OutboxEventStatus.Failed,
      ],
    );
    return result.affectedRows ?? 0;
  }

  /**
   * The recipient, template, locale, and cumulative attempts are deliberately not
   * touched. The recipient especially: it is the snapshot taken on the first attempt,
   * and re-resolving it here would turn an operator's retry into a message to a
   * different address than the one the delivery record claims.
   *
   * `provider_message_id` is cleared because the state check requires it of a
   * `PENDING` row, and because an id from a send that did not deliver is not evidence
   * about the send that is about to happen.
   */
  private async resetDeliveries(
    manager: EntityManager,
    outboxEventId: string,
  ): Promise<number> {
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE email_deliveries
       SET status = ?,
           failed_at = NULL,
           provider_message_id = NULL
       WHERE outbox_event_id = ? AND status = ?`,
      [EmailDeliveryStatus.Pending, outboxEventId, EmailDeliveryStatus.Failed],
    );
    return result.affectedRows ?? 0;
  }

  private refuse(
    request: RedriveRequest,
    code: RedriveResult['code'],
    observedEventStatus: OutboxEventStatus | null,
  ): RedriveResult {
    return {
      applied: false,
      code,
      outboxEventId: request.outboxEventId,
      observedEventStatus,
      deliveriesReset: 0,
    };
  }
}
