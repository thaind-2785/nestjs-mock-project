import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from '../bookings/entities/booking.enums';
import { EmailDeliveryStatus } from './entities/notification.enums';
import { notificationEventTypes } from './notification-event';
import type {
  DeliveryFailureInput,
  DeliveryResultKey,
  DeliveryRetryInput,
  DeliverySentInput,
} from './delivery-result.types';

const notificationEventTypePlaceholders = notificationEventTypes
  .map(() => '?')
  .join(', ');

/**
 * Writes what happened, in one short transaction, after the provider call is over.
 *
 * The outbox row is updated first and the delivery row only if that succeeded. That
 * ordering is the guard: the outbox carries the claim, so a worker whose lease
 * expired while it was talking to the provider matches zero rows and writes nothing
 * at all, rather than resolving a delivery that now belongs to another worker. Every
 * method returns whether it still held the claim, and the caller has to act on it -
 * a discarded `false` is how a delivered message ends up with an outbox row nobody
 * ever finalizes. It also fixes the lock order: outbox before delivery, everywhere.
 *
 * That is the price of at-least-once - a duplicate send is possible, a contradictory
 * record is not.
 */
@Injectable()
export class DeliveryResultRepository {
  async markSent(
    manager: EntityManager,
    input: DeliverySentInput,
  ): Promise<boolean> {
    const held = await this.finishEvent(manager, input, {
      status: OutboxEventStatus.Processed,
      // A processed event carries no failure evidence: success clears the code that
      // explained the retry that got here.
      assignments: 'processed_at = NOW(6), last_error_code = NULL',
      parameters: [],
    });
    if (!held) return false;
    await this.updateDelivery(
      manager,
      input,
      'status = ?, sent_at = NOW(6), provider_message_id = ?, last_error_code = NULL',
      [EmailDeliveryStatus.Sent, input.providerMessageId],
    );
    return true;
  }

  async markRetry(
    manager: EntityManager,
    input: DeliveryRetryInput,
  ): Promise<boolean> {
    // The attempt stays spent: this one reached the provider, unlike a queue handoff
    // that never left the dispatcher.
    const held = await this.finishEvent(manager, input, {
      status: OutboxEventStatus.Pending,
      assignments:
        'available_at = NOW(6) + INTERVAL ? MICROSECOND, last_error_code = ?',
      parameters: [input.retryInMs * 1_000, input.errorCode],
    });
    if (!held) return false;
    await this.updateDelivery(manager, input, 'last_error_code = ?', [
      input.errorCode,
    ]);
    return true;
  }

  async markFailed(
    manager: EntityManager,
    input: DeliveryFailureInput,
  ): Promise<boolean> {
    const held = await this.finishEvent(manager, input, {
      status: OutboxEventStatus.Failed,
      assignments: 'failed_at = NOW(6), last_error_code = ?',
      parameters: [input.errorCode],
    });
    if (!held) return false;
    await this.updateDelivery(
      manager,
      input,
      'status = ?, failed_at = NOW(6), last_error_code = ?',
      [EmailDeliveryStatus.Failed, input.errorCode],
    );
    return true;
  }

  /**
   * Finalizes an event whose delivery another job already resolved. A no-op that
   * leaves the claim un-finalized is not a no-op: the row stays `PROCESSING`, is
   * re-claimed at every lease expiry, and never reaches a state the redrive CLI can
   * act on. The delivery row is read without a lock, keeping the outbox-first order.
   */
  async matchResolvedDelivery(
    manager: EntityManager,
    key: DeliveryResultKey,
  ): Promise<boolean> {
    const rows: Array<{
      status: EmailDeliveryStatus;
      lastErrorCode: string | null;
    }> = await manager.query(
      `SELECT status, last_error_code AS lastErrorCode
         FROM email_deliveries WHERE outbox_event_id = ?`,
      [key.outboxEventId],
    );
    const delivery = rows[0];
    if (delivery?.status === EmailDeliveryStatus.Sent) {
      return this.finishEvent(manager, key, {
        status: OutboxEventStatus.Processed,
        assignments: 'processed_at = NOW(6), last_error_code = NULL',
        parameters: [],
      });
    }
    if (delivery?.status === EmailDeliveryStatus.Failed) {
      return this.finishEvent(manager, key, {
        status: OutboxEventStatus.Failed,
        assignments: 'failed_at = NOW(6), last_error_code = ?',
        parameters: [delivery.lastErrorCode ?? 'MAIL_PROVIDER_REJECTED'],
      });
    }
    return false;
  }

  private async updateDelivery(
    manager: EntityManager,
    key: DeliveryResultKey,
    assignments: string,
    parameters: unknown[],
  ): Promise<void> {
    // Addressed by id when the caller prepared one, and by event otherwise: a payload
    // that never parsed has no delivery row to address.
    const [predicate, identifier] = key.deliveryId
      ? ['id = ?', key.deliveryId]
      : ['outbox_event_id = ?', key.outboxEventId];
    await manager.query(
      `UPDATE email_deliveries SET ${assignments}
       WHERE ${predicate} AND status = ?`,
      [...parameters, identifier, EmailDeliveryStatus.Pending],
    );
  }

  /**
   * The claim token already makes a foreign row unmatchable, because only this
   * dispatcher could have written it. The event type is here anyway: that argument
   * holds only while the token is generated where it is today, and a finalize that
   * can write to the wrong family is the failure nobody would find from the outside.
   */
  private async finishEvent(
    manager: EntityManager,
    key: DeliveryResultKey,
    outcome: {
      status: OutboxEventStatus;
      assignments: string;
      parameters: unknown[];
    },
  ): Promise<boolean> {
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE outbox_events
       SET status = ?,
           locked_at = NULL,
           lock_expires_at = NULL,
           locked_by = NULL,
           ${outcome.assignments}
       WHERE id = ?
         AND event_type IN (${notificationEventTypePlaceholders})
         AND status = ?
         AND locked_by = ?
         AND attempts = ?`,
      [
        outcome.status,
        ...outcome.parameters,
        key.outboxEventId,
        ...notificationEventTypes,
        OutboxEventStatus.Processing,
        key.claimToken,
        key.attempt,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }
}
