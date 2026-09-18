import { DataSource, EntityManager } from 'typeorm';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { validateEnvironment } from '../config/environment.validation';
import { createNotificationsConfiguration } from '../config/notifications.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import type { OutboxClaim } from '../common/outbox/outbox-claim.types';
import {
  notificationJobName,
  notificationQueueUnavailableCode,
} from './outbox-dispatcher.constants';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

const configuration = createNotificationsConfiguration(
  validateEnvironment({
    NOTIFICATION_CLAIM_BATCH_SIZE: '10',
    NOTIFICATION_POLL_INTERVAL_MS: '1000',
    NOTIFICATION_BACKOFF_INITIAL_MS: '30000',
  }),
);

function createHarness(options: {
  claims: OutboxClaim[];
  add?: jest.Mock;
  release?: jest.Mock;
}) {
  const order: string[] = [];
  const manager = {} as EntityManager;
  // TypeORM's `transaction` is overloaded: the dispatcher passes an isolation level
  // for the claim and omits it elsewhere, so the double has to accept both shapes.
  const transaction = jest.fn(async (...args: unknown[]) => {
    const run = (typeof args[0] === 'function' ? args[0] : args[1]) as (
      entityManager: EntityManager,
    ) => Promise<unknown>;
    const result = await run(manager);
    order.push('commit');
    return result;
  });
  const dataSource = { transaction } as unknown as DataSource;
  const database = {
    ensureInitialized: jest.fn().mockResolvedValue(dataSource),
  } as unknown as DatabaseConnectionService;
  const claimBatch = jest.fn().mockResolvedValue(options.claims);
  const release = options.release ?? jest.fn().mockResolvedValue(true);
  const claims = { claimBatch, release } as unknown as OutboxClaimRepository;
  const add =
    options.add ??
    jest.fn(() => {
      order.push('add');
      return Promise.resolve({});
    });
  const close = jest.fn().mockResolvedValue(undefined);
  const quit = jest.fn().mockResolvedValue('OK');
  const queue = { add, close } as unknown as Queue;
  const queueClient = { quit } as unknown as Redis;
  const service = new OutboxDispatcherService(
    database,
    claims,
    queue,
    queueClient,
    configuration,
  );
  return { service, add, release, claimBatch, order, close, quit };
}

describe('OutboxDispatcherService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('enqueues one opaque job per claim after the claim has committed', async () => {
    const harness = createHarness({
      claims: [
        { id: '4f1d0c1e-0000-4000-8000-000000000001', attempt: 1 },
        { id: '4f1d0c1e-0000-4000-8000-000000000002', attempt: 3 },
      ],
    });

    const result = await harness.service.runOnce();

    expect(result).toEqual({ claimed: 2, queued: 2, released: 0 });
    // Redis is touched only after MySQL has the claim: a crash in between must leave
    // an expiring lease, never a job for a row nobody owns.
    expect(harness.order).toEqual(['commit', 'add', 'add']);
    expect(harness.add).toHaveBeenNthCalledWith(
      2,
      notificationJobName,
      expect.objectContaining({
        outboxEventId: '4f1d0c1e-0000-4000-8000-000000000002',
        attempt: 3,
      }),
      expect.objectContaining({
        jobId: '4f1d0c1e-0000-4000-8000-000000000002-3',
        attempts: 1,
      }),
    );
    // No recipient, payload, reason or rendered body reaches the queue, and the
    // token the worker will be checked against is the one the claim was made with.
    const [, data] = harness.add.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(data).sort()).toEqual([
      'attempt',
      'claimToken',
      'outboxEventId',
    ]);
    expect(typeof data.claimToken).toBe('string');
  });

  it('hands a refused claim back with its next retry time', async () => {
    const release = jest.fn().mockResolvedValue(true);
    const harness = createHarness({
      claims: [{ id: '4f1d0c1e-0000-4000-8000-000000000003', attempt: 2 }],
      add: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      release,
    });
    const result = await harness.service.runOnce();

    expect(result).toEqual({ claimed: 1, queued: 0, released: 1 });
    expect(release).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: '4f1d0c1e-0000-4000-8000-000000000003',
        attempt: 2,
        errorCode: notificationQueueUnavailableCode,
      }),
    );
    // Second attempt: at least the doubled base delay, plus bounded jitter. The
    // delay is handed over as a duration, so the database applies it when the release
    // runs rather than against a clock read before the queue stalled.
    const [, input] = release.mock.calls[0] as [
      unknown,
      { retryInMs: number; claimToken: string },
    ];
    expect(input.retryInMs).toBeGreaterThanOrEqual(60_000);
    expect(input.retryInMs).toBeLessThanOrEqual(72_000);
    // Released under the same token it was claimed with, so a claim that has since
    // expired and been recovered by another dispatcher is left alone.
    const [, claimInput] = harness.claimBatch.mock.calls[0] as [
      unknown,
      { claimToken: string },
    ];
    expect(input.claimToken).toBe(claimInput.claimToken);
  });

  it('closes the queue and its connection when the context shuts down', async () => {
    const harness = createHarness({ claims: [] });

    await harness.service.onApplicationShutdown();

    // BullMQ leaves a connection it did not create open, so closing the queue alone
    // would keep a live socket and a process that only `process.exit` can end.
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.quit).toHaveBeenCalledTimes(1);
  });

  it('never runs two poll cycles at once and waits for the last one to finish', async () => {
    jest.useFakeTimers();
    let active = 0;
    let overlapped = false;
    const harness = createHarness({ claims: [] });
    const runOnce = jest
      .spyOn(harness.service, 'runOnce')
      .mockImplementation(async () => {
        active += 1;
        if (active > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
        return { claimed: 0, queued: 0, released: 0 };
      });

    harness.service.start();
    harness.service.start();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(overlapped).toBe(false);
    expect(runOnce).toHaveBeenCalled();

    const cycles = runOnce.mock.calls.length;
    await harness.service.stop();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(runOnce.mock.calls.length).toBe(cycles);
  });

  it('keeps polling after a cycle fails', async () => {
    jest.useFakeTimers();
    const harness = createHarness({ claims: [] });
    const runOnce = jest
      .spyOn(harness.service, 'runOnce')
      .mockRejectedValueOnce(new Error('MySQL unavailable'))
      .mockResolvedValue({ claimed: 0, queued: 0, released: 0 });

    harness.service.start();
    await jest.advanceTimersByTimeAsync(3_000);
    await harness.service.stop();

    // A poll that cannot reach MySQL must not end the loop; its committed claims are
    // protected by their lease and the next tick tries again.
    expect(runOnce.mock.calls.length).toBeGreaterThan(1);
  });
});
