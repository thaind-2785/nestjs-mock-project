import { EntityManager } from 'typeorm';
import { validateEnvironment } from '../config/environment.validation';
import { createNotificationsConfiguration } from '../config/notifications.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { DeliveryPreparationService } from './delivery-preparation.service';
import { deliveryPreparationErrorCodes } from './delivery-preparation.constants';
import { DeliveryPreparationError } from './delivery-preparation.error';
import type { PreparedNotification } from './delivery-preparation.types';
import { DeliveryResultRepository } from './delivery-result.repository';
import { DeliveryWorkerService } from './delivery-worker.service';
import { EmailDeliveryLocale } from './entities/notification.enums';
import { EmailSender } from './email-sender';
import { NotificationEventError } from './notification-event';
import type { NotificationJobData } from './outbox-dispatcher.types';
import { SendAttemptRepository } from './send-attempt.repository';
import { smtpErrorCodes } from './smtp-error';

const job: NotificationJobData = {
  outboxEventId: '9f1d0c1e-0000-4000-8000-000000000001',
  claimToken: 'token-1',
  attempt: 2,
};

const prepared = {
  deliveryId: '7',
  eventType: 'booking.confirmed',
  templateKey: 'booking.confirmed.v1',
  locale: EmailDeliveryLocale.English,
  recipient: 'owner@hotel.test',
  message: { subject: 'Booking confirmed' },
} as unknown as PreparedNotification;

function createWorker(options: {
  prepare?: jest.Mock;
  send?: jest.Mock;
  attempt?: number;
  maxAttempts?: number;
}) {
  const order: string[] = [];
  const configuration = createNotificationsConfiguration(
    validateEnvironment({
      NOTIFICATION_MAX_ATTEMPTS: String(options.maxAttempts ?? 5),
      NOTIFICATION_BACKOFF_INITIAL_MS: '30000',
    }),
  );
  const manager = {
    query: jest.fn().mockResolvedValue([{ id: 'delivery-7' }]),
  } as unknown as EntityManager;
  const database = {
    ensureInitialized: jest.fn().mockResolvedValue({
      transaction: jest.fn(
        async (run: (m: EntityManager) => Promise<unknown>) => {
          order.push('transaction:open');
          const result = await run(manager);
          order.push('transaction:commit');
          return result;
        },
      ),
    }),
  } as unknown as DatabaseConnectionService;
  const preparation = {
    prepare: options.prepare ?? jest.fn().mockResolvedValue(prepared),
  } as unknown as DeliveryPreparationService;
  const markSent = jest.fn().mockResolvedValue(true);
  const markRetry = jest.fn().mockResolvedValue(true);
  const markFailed = jest.fn().mockResolvedValue(true);
  const matchResolvedDelivery = jest.fn().mockResolvedValue(true);
  const results = {
    markSent,
    markRetry,
    markFailed,
    matchResolvedDelivery,
  } as unknown as DeliveryResultRepository;
  const send =
    options.send ??
    jest.fn(() => {
      order.push('send');
      return Promise.resolve({ providerMessageId: '<provider@id>' });
    });
  const sender = { send } as unknown as EmailSender;
  const recordAccepted = jest.fn(() => {
    order.push('recordAccepted');
    return Promise.resolve();
  });
  const sendAttempts = {
    recordAccepted,
    countAccepted: jest.fn(() => Promise.resolve(0)),
  } as unknown as SendAttemptRepository;
  const client = { quit: jest.fn() } as unknown as never;
  const service = new DeliveryWorkerService(
    database,
    preparation,
    results,
    sendAttempts,
    sender,
    client,
    configuration,
  );
  return {
    service,
    recordAccepted,
    send,
    markSent,
    markRetry,
    markFailed,
    matchResolvedDelivery,
    order,
    manager,
  };
}

describe('DeliveryWorkerService', () => {
  it('sends once and records the provider acceptance', async () => {
    const harness = createWorker({});

    await expect(harness.service.process(job)).resolves.toBe('sent');

    // The provider call happens between two transactions, never inside one: no
    // database connection is held across the network, and no accepted message can be
    // undone by a rollback.
    //
    // The acceptance is appended immediately after the send and before the result
    // transaction, and outside any transaction of its own - it adds no open/commit
    // pair here. Both positions are load-bearing. Recording it before the send would
    // claim a delivery the provider might still refuse; recording it inside the result
    // transaction would tie the evidence to holding a claim, which is exactly the case
    // where it is the only evidence left.
    expect(harness.order).toEqual([
      'transaction:open',
      'transaction:commit',
      'send',
      'recordAccepted',
      'transaction:open',
      'transaction:commit',
    ]);
    expect(harness.markSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outboxEventId: job.outboxEventId,
        claimToken: job.claimToken,
        attempt: job.attempt,
        providerMessageId: '<provider@id>',
      }),
    );
  });

  it('does nothing for a job whose claim is gone', async () => {
    const harness = createWorker({});
    (harness.manager.query as jest.Mock).mockResolvedValue([]);

    await expect(harness.service.process(job)).resolves.toBe('skipped');

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.markSent).not.toHaveBeenCalled();
    expect(harness.markFailed).not.toHaveBeenCalled();
  });

  it('treats an already resolved delivery as a successful no-op', async () => {
    // SPEC-007 calls a duplicate or stale job a successful no-op. Recording it as a
    // failure would mark an event that was already delivered permanently failed.
    const harness = createWorker({
      prepare: jest
        .fn()
        .mockRejectedValue(
          new DeliveryPreparationError(
            deliveryPreparationErrorCodes.deliveryNotPending,
          ),
        ),
    });

    await expect(harness.service.process(job)).resolves.toBe('skipped');

    expect(harness.markFailed).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    // The claim is still this job's, so the event has to be finalized to match the
    // delivery. Leaving it PROCESSING would strand it under an expiring lease.
    expect(harness.matchResolvedDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outboxEventId: job.outboxEventId,
        claimToken: job.claimToken,
      }),
    );
  });

  it('fails permanently on a payload or recipient it cannot use', async () => {
    for (const error of [
      new NotificationEventError('NOTIFICATION_EVENT_INVALID', 'bad payload'),
      new DeliveryPreparationError(deliveryPreparationErrorCodes.ownerNotFound),
    ]) {
      const harness = createWorker({
        prepare: jest.fn().mockRejectedValue(error),
      });

      await expect(harness.service.process(job)).resolves.toBe('failed');

      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.markFailed).toHaveBeenCalled();
    }
  });

  it('lets an unexpected failure recover through the lease instead of judging it', async () => {
    const harness = createWorker({
      prepare: jest.fn().mockRejectedValue(new Error('MySQL went away')),
    });

    // Not a verdict about the message: the claim keeps its lease and another
    // dispatcher picks it up when that expires.
    await expect(harness.service.process(job)).rejects.toThrow(
      'MySQL went away',
    );
    expect(harness.markFailed).not.toHaveBeenCalled();
  });

  it('reschedules a transient provider failure with a bounded delay', async () => {
    const harness = createWorker({
      send: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('busy'), { responseCode: 421 }),
        ),
    });

    await expect(harness.service.process(job)).resolves.toBe('retry');

    const [, input] = harness.markRetry.mock.calls[0] as [
      unknown,
      { retryInMs: number; errorCode: string },
    ];
    expect(input.errorCode).toBe(smtpErrorCodes.unavailable);
    expect(input.retryInMs).toBeGreaterThanOrEqual(60_000);
    expect(input.retryInMs).toBeLessThanOrEqual(72_000);
    expect(harness.markFailed).not.toHaveBeenCalled();
  });

  it('stops retrying a transient failure once the budget is spent', async () => {
    const harness = createWorker({
      maxAttempts: 2,
      send: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('busy'), { responseCode: 421 }),
        ),
    });

    // The same error that was retryable a moment ago is terminal at the last attempt.
    await expect(harness.service.process(job)).resolves.toBe('failed');

    expect(harness.markRetry).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: smtpErrorCodes.unavailable }),
    );
  });

  it('never retries a rejection the provider will repeat', async () => {
    const harness = createWorker({
      send: jest.fn().mockRejectedValue(
        // The envelope phase is what names a recipient; a bare 550 can be the
        // sender's own quota, which the classifier spec covers separately.
        Object.assign(new Error('no mailbox'), {
          code: 'EENVELOPE',
          responseCode: 550,
        }),
      ),
    });

    await expect(harness.service.process(job)).resolves.toBe('failed');

    expect(harness.markRetry).not.toHaveBeenCalled();
    expect(harness.markFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: smtpErrorCodes.recipientInvalid }),
    );
  });
});
