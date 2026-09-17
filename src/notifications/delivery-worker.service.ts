import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type Redis from 'ioredis';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from '../bookings/entities/booking.enums';
import { notificationsConfig } from '../config/notifications.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { deliveryPreparationErrorCodes } from './delivery-preparation.constants';
import { DeliveryPreparationError } from './delivery-preparation.error';
import { DeliveryPreparationService } from './delivery-preparation.service';
import type { PreparedNotification } from './delivery-preparation.types';
import { DeliveryResultRepository } from './delivery-result.repository';
import type { ClaimedWork, DeliveryOutcome } from './delivery-worker.types';
import { EMAIL_SENDER } from './email-sender';
import type { EmailSender, EmailSendResult } from './email-sender';
import { NotificationEventError } from './notification-event';
import { notificationBackoffMs } from './notification-backoff';
import { NOTIFICATION_WORKER_CLIENT } from './notification.tokens';
import { NotificationWorkerLifecycle } from './notification-worker-lifecycle';
import type { NotificationJobData } from './outbox-dispatcher.types';
import { SendAttemptRepository } from './send-attempt.repository';
import { classifySmtpFailure } from './smtp-error';

/**
 * Consumes one delivery job.
 *
 * The shape of this handler is the whole at-least-once argument: two short
 * transactions with the provider call between them, never inside them. A database
 * connection is not held across a network call, and no transaction can be rolled back
 * by a message the provider has already accepted.
 */
@Injectable()
export class DeliveryWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(DeliveryWorkerService.name);
  private readonly worker = new NotificationWorkerLifecycle();

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly preparation: DeliveryPreparationService,
    private readonly results: DeliveryResultRepository,
    private readonly sendAttempts: SendAttemptRepository,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(NOTIFICATION_WORKER_CLIENT) private readonly client: Redis,
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    const { queue, worker } = this.configuration;
    this.worker.start({
      queueName: queue.name,
      queuePrefix: queue.prefix,
      concurrency: worker.concurrency,
      client: this.client,
      process: (data) => this.process(data),
      logger: this.logger,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Closing the worker waits for jobs in flight; the bounded drain above it decides
    // how long that may take.
    await this.worker.close();
    await this.client.quit();
  }

  async process(data: NotificationJobData): Promise<DeliveryOutcome> {
    const dataSource = await this.database.ensureInitialized();
    let claimed: ClaimedWork | null;
    try {
      claimed = await dataSource.transaction((manager) =>
        this.claimWork(manager, data),
      );
    } catch (error: unknown) {
      return this.finishWithoutSending(data, error);
    }
    // A duplicate job, or one whose claim has since expired and been recovered, is
    // work somebody else owns now. Doing nothing is the correct answer, and saying so
    // is not a failure.
    if (!claimed) return this.record(data, 'skipped', 'stale_claim');

    const { prepared } = claimed;
    let sent: EmailSendResult;
    try {
      sent = await this.sender.send(prepared.message);
    } catch (error: unknown) {
      return this.recordProviderFailure(dataSource, data, prepared, error);
    }

    // The provider has accepted. Nothing below this line is a verdict about the
    // message, and nothing below it may be classified as one: a database fault here
    // used to fall through `classifySmtpFailure`'s catch-all, be recorded as
    // MAIL_PROVIDER_UNAVAILABLE, and reschedule a message the guest already had -
    // sending it again on every remaining attempt while blaming the provider.
    await this.recordAcceptance(data, prepared, sent);

    const held = await dataSource.transaction((manager) =>
      this.results.markSent(manager, {
        ...this.resultKey(data, prepared),
        providerMessageId: sent.providerMessageId,
      }),
    );
    // The provider accepted it and the claim moved on while we waited: the message
    // is out, and whoever holds the claim now decides what the record says. This is
    // the at-least-once window, and it has to be visible rather than silent.
    if (!held) return this.record(data, 'skipped', 'claim_lost_after_send');
    return this.record(data, 'sent', prepared.templateKey);
  }

  /**
   * Appends the evidence that a provider accepted this message, and never fails the
   * delivery for it.
   *
   * The row is evidence, not an outcome. Letting it throw would turn "we could not
   * write a note about a message that was delivered" into "the message was not
   * delivered", which reschedules a send the guest already received. A worker that
   * cannot record it is strictly better off saying so and moving on: the operator
   * loses the redrive guard for this event, which is the smaller harm and is the
   * state that existed before this table.
   */
  private async recordAcceptance(
    data: NotificationJobData,
    prepared: PreparedNotification,
    sent: EmailSendResult,
  ): Promise<void> {
    try {
      const dataSource = await this.database.ensureInitialized();
      await this.sendAttempts.recordAccepted(dataSource.manager, {
        outboxEventId: data.outboxEventId,
        templateKey: prepared.templateKey,
        providerMessageId: sent.providerMessageId,
        claimToken: data.claimToken,
        attempt: data.attempt,
      });
    } catch (error: unknown) {
      this.logger.error({
        event: 'notification_send_attempt_record_failed',
        outboxEventId: data.outboxEventId,
        attempt: data.attempt,
        reason:
          error instanceof Error ? error.name : 'SEND_ATTEMPT_RECORD_FAILED',
      });
    }
  }

  /**
   * Re-checks the claim under a row lock before doing anything else. The job carries
   * the token and attempt it was created with; if the row no longer agrees, this job
   * is a ghost of a claim that has already been recovered.
   */
  private async claimWork(
    manager: EntityManager,
    data: NotificationJobData,
  ): Promise<ClaimedWork | null> {
    const held: Array<{ id: string; eventType: string; payload: unknown }> =
      await manager.query(
        `SELECT id, event_type AS eventType, payload
       FROM outbox_events
       WHERE id = ?
         AND status = ?
         AND locked_by = ?
         AND attempts = ?
         AND lock_expires_at > NOW(6)
       FOR UPDATE`,
        [
          data.outboxEventId,
          OutboxEventStatus.Processing,
          data.claimToken,
          data.attempt,
        ],
      );
    if (held.length === 0) return null;

    const prepared = await this.preparation.prepare(manager, {
      id: held[0].id,
      eventType: held[0].eventType,
      payload: held[0].payload as Record<string, unknown>,
    });
    // The lease is renewed before the provider call so the send is protected by a
    // full lease rather than by whatever was left of the one the dispatcher issued.
    await manager.query(
      `UPDATE outbox_events
       SET lock_expires_at = NOW(6) + INTERVAL ? MICROSECOND
       WHERE id = ? AND locked_by = ?`,
      [
        this.configuration.relay.claimLeaseMs * 1_000,
        data.outboxEventId,
        data.claimToken,
      ],
    );
    return { prepared };
  }

  private async finishWithoutSending(
    data: NotificationJobData,
    error: unknown,
  ): Promise<DeliveryOutcome> {
    // The delivery already resolved under another job: SPEC-007 calls that a
    // successful no-op, and treating it as a failure would mark a delivered event
    // permanently failed.
    if (
      error instanceof DeliveryPreparationError &&
      error.code === deliveryPreparationErrorCodes.deliveryNotPending
    ) {
      // Another job already resolved the delivery, but this job still holds the
      // claim. Leaving the event `PROCESSING` would strand it: re-claimed at every
      // lease expiry, counted as active work forever, and refused by the redrive CLI.
      const dataSource = await this.database.ensureInitialized();
      await dataSource.transaction((manager) =>
        this.results.matchResolvedDelivery(manager, {
          outboxEventId: data.outboxEventId,
          claimToken: data.claimToken,
          attempt: data.attempt,
        }),
      );
      return this.record(data, 'skipped', 'delivery_resolved');
    }
    // A payload this worker cannot read, or a recipient it cannot resolve, will not
    // become readable by waiting.
    const permanent =
      error instanceof NotificationEventError
        ? error.code
        : error instanceof DeliveryPreparationError
          ? error.code
          : undefined;
    if (!permanent) {
      // Anything else - a database that went away mid-transaction - is not a verdict
      // about the message. The claim keeps its lease and is recovered when it expires.
      throw error;
    }
    await this.failPermanently(data, permanent);
    return this.record(data, 'failed', permanent);
  }

  private async failPermanently(
    data: NotificationJobData,
    errorCode: string,
  ): Promise<void> {
    const dataSource = await this.database.ensureInitialized();
    // No delivery read first: locking `email_deliveries` before `outbox_events` is
    // the opposite order from every other path here, and MySQL answers the crossing
    // with a deadlock. The repository addresses the delivery by event when no id is
    // given, which is also the only thing available when a payload never parsed far
    // enough to create one.
    await dataSource.transaction((manager) =>
      this.results.markFailed(manager, {
        outboxEventId: data.outboxEventId,
        claimToken: data.claimToken,
        attempt: data.attempt,
        errorCode,
      }),
    );
  }

  private async recordProviderFailure(
    dataSource: {
      transaction: <T>(
        run: (manager: EntityManager) => Promise<T>,
      ) => Promise<T>;
    },
    data: NotificationJobData,
    prepared: PreparedNotification,
    error: unknown,
  ): Promise<DeliveryOutcome> {
    const failure = classifySmtpFailure(error);
    const { relay } = this.configuration;
    const exhausted = data.attempt >= relay.maxAttempts;
    const key = this.resultKey(data, prepared);
    if (!failure.retryable || exhausted) {
      const held = await dataSource.transaction((manager) =>
        this.results.markFailed(manager, { ...key, errorCode: failure.code }),
      );
      if (!held) return this.record(data, 'skipped', 'claim_lost_after_send');
      return this.record(
        data,
        'failed',
        exhausted && failure.retryable ? 'retries_exhausted' : failure.code,
      );
    }
    const held = await dataSource.transaction((manager) =>
      this.results.markRetry(manager, {
        ...key,
        errorCode: failure.code,
        retryInMs: notificationBackoffMs(data.attempt, {
          initialMs: relay.backoffInitialMs,
          maxMs: relay.backoffMaxMs,
        }),
      }),
    );
    if (!held) return this.record(data, 'skipped', 'claim_lost_after_send');
    return this.record(data, 'retry', failure.code);
  }

  private resultKey(data: NotificationJobData, prepared: PreparedNotification) {
    return {
      outboxEventId: data.outboxEventId,
      claimToken: data.claimToken,
      attempt: data.attempt,
      deliveryId: prepared.deliveryId,
    };
  }

  private record(
    data: NotificationJobData,
    outcome: DeliveryOutcome,
    reason: string,
  ): DeliveryOutcome {
    // Opaque identifiers and stable reasons only: no recipient, subject, reason text
    // or rendered body reaches a log line.
    this.logger.log({
      event: 'notification_delivery_finished',
      outboxEventId: data.outboxEventId,
      attempt: data.attempt,
      outcome,
      reason,
    });
    return outcome;
  }
}
