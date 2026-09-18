import { Logger } from '@nestjs/common';
import { OutboxEventStatus } from '../common/outbox/outbox.enums';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { notificationsConfig } from '../config/notifications.config';
import type { DatabaseConnectionService } from '../database/database-connection.service';
import { EmailDeliveryStatus } from './entities/notification.enums';
import { NotificationBacklogRepository } from './notification-backlog.repository';
import { NotificationBacklogService } from './notification-backlog.service';
import type { NotificationBacklogSnapshot } from './notification-backlog.types';

type LoggedSample = Record<string, unknown>;

const snapshot: NotificationBacklogSnapshot = {
  outbox: [
    {
      eventType: 'booking.confirmed',
      status: OutboxEventStatus.Pending,
      count: 3,
      oldestAvailableAgeMs: 12_000,
    },
    {
      eventType: 'booking.rejected',
      status: OutboxEventStatus.Pending,
      count: 1,
      oldestAvailableAgeMs: 95_000,
    },
    {
      // Deliberately the largest age in the snapshot, and deliberately not PENDING.
      // The repository now zeroes a non-pending age in SQL, so this fixture is
      // stricter than reality on purpose: it pins the service's own guard, which is
      // what would have to hold if that SQL ever changed.
      eventType: 'booking.cancelled',
      status: OutboxEventStatus.Processing,
      count: 2,
      oldestAvailableAgeMs: 900_000,
    },
  ],
  leases: { expiredCount: 2, oldestExpiredAgeMs: 7_000_000 },
  deliveries: [
    {
      templateKey: 'booking.confirmed.v1',
      status: EmailDeliveryStatus.Sent,
      count: 40,
    },
    {
      templateKey: 'booking.rejected.v1',
      status: EmailDeliveryStatus.Failed,
      count: 2,
    },
  ],
};

describe('NotificationBacklogService', () => {
  let logged: LoggedSample[];
  let errors: LoggedSample[];

  function createService(overrides: {
    read?: () => Promise<NotificationBacklogSnapshot>;
    getJobCounts?: () => Promise<Record<string, number>>;
    backlogSampleIntervalMs?: number;
  }): NotificationBacklogService {
    const database = {
      ensureInitialized: () => Promise.resolve({ manager: {} }),
    } as unknown as DatabaseConnectionService;
    const backlog = {
      read: overrides.read ?? (() => Promise.resolve(snapshot)),
    } as unknown as NotificationBacklogRepository;
    const queue = {
      getJobCounts:
        overrides.getJobCounts ??
        (() =>
          Promise.resolve({
            waiting: 4,
            active: 1,
            delayed: 2,
            failed: 0,
            completed: 37,
          })),
    } as unknown as Queue;
    const configuration = {
      transport: { provider: 'MAILPIT' },
      observability: {
        backlogSampleIntervalMs: overrides.backlogSampleIntervalMs ?? 60_000,
      },
    } as unknown as ConfigType<typeof notificationsConfig>;
    return new NotificationBacklogService(
      database,
      backlog,
      queue,
      configuration,
    );
  }

  beforeEach(() => {
    logged = [];
    errors = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((entry: unknown) => {
      logged.push(entry as LoggedSample);
    });
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((entry: unknown) => {
        errors.push(entry as LoggedSample);
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits one sample carrying the grouped counts and the queue depth', async () => {
    await createService({}).runOnce();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'notification_backlog_sampled',
      provider: 'MAILPIT',
      outbox: snapshot.outbox,
      deliveries: snapshot.deliveries,
      queue: { waiting: 4, active: 1, delayed: 2, failed: 0, completed: 37 },
    });
    expect(logged[0].durationMs).toEqual(expect.any(Number));
  });

  it('reports the oldest pending age from pending groups only', async () => {
    await createService({}).runOnce();

    // 900_000 belongs to a PROCESSING group: that event has been claimed and is being
    // worked, so counting it as backlog age would fire a "nothing is draining" alert
    // at exactly the moment the pipeline is draining.
    expect(logged[0].oldestPendingAgeMs).toBe(95_000);
  });

  it('reports no pending age when nothing is waiting', async () => {
    await createService({
      read: () =>
        Promise.resolve({
          outbox: [],
          leases: { expiredCount: 0, oldestExpiredAgeMs: 0 },
          deliveries: [],
        }),
    }).runOnce();

    expect(logged[0].oldestPendingAgeMs).toBe(0);
  });

  it('still publishes the database backlog when the queue is unreachable', async () => {
    await createService({
      getJobCounts: () => Promise.reject(new Error('ECONNREFUSED')),
    }).runOnce();

    // A queue outage is exactly when the outbox backlog is the number worth seeing.
    expect(logged).toHaveLength(1);
    expect(logged[0].queue).toBeNull();
    expect(logged[0].outbox).toEqual(snapshot.outbox);
  });

  it('carries no recipient, subject, or payload into the log', async () => {
    await createService({}).runOnce();

    const serialized = JSON.stringify(logged[0]);
    // Every value in the sample is an identifier this repository defines. If a
    // recipient or a rendered body ever reaches it, the address is what shows up.
    expect(serialized).not.toContain('@');
    expect(serialized.toLowerCase()).not.toContain('subject');
    expect(serialized.toLowerCase()).not.toContain('payload');
  });

  it('keeps the loop alive when a sample fails', async () => {
    // Every TypeORM driver failure arrives as QueryFailedError, so the class name
    // would tell an operator paged by "no samples" nothing at all.
    const driverFailure = Object.assign(new Error('QueryFailedError'), {
      code: 'ER_LOCK_WAIT_TIMEOUT',
    });
    const service = createService({
      read: () => Promise.reject(driverFailure),
    });

    await expect(service.runOnce()).rejects.toThrow('QueryFailedError');

    // The scheduled path swallows it into an error line instead; the absence of
    // samples is the alert, not a dead worker.
    service.start();
    // Long enough for the immediate first sample to fire and reject. Stopping any
    // sooner would clear the timer before it ran, which is what shutdown does.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.stop();
    expect(errors[0]).toMatchObject({
      event: 'notification_backlog_sample_failed',
      reason: 'ER_LOCK_WAIT_TIMEOUT',
    });
  });

  it('names a failure with no driver code by a stable constant', async () => {
    const service = createService({
      read: () => Promise.reject(new Error('something unhelpful')),
    });

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.stop();

    expect(errors[0]).toMatchObject({ reason: 'BACKLOG_SAMPLE_FAILED' });
  });

  it('does not reschedule when shutdown races a sample already running', async () => {
    // The previous test stops before the first sample fires, so the timer is merely
    // cleared and the reschedule guard never executes. Deleting that guard left the
    // whole suite green. This is the case it exists for: stop() arrives while a
    // sample is in flight, and the `finally` that runs afterwards must not arm
    // another timer against a database handle the context is closing.
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createService({
      // Short enough that a reschedule the guard should have prevented fires inside
      // this test rather than sixty seconds after it, which is the difference between
      // a failing assertion and a suite that merely hangs on an open handle.
      backlogSampleIntervalMs: 20,
      read: async () => {
        await blocked;
        return snapshot;
      },
    });

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopping = service.stop();
    release();
    await stopping;

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(logged).toHaveLength(1);
  });

  it('stops sampling after shutdown', async () => {
    const service = createService({});
    service.start();
    await service.stop();
    const sampledBeforeRestart = logged.length;

    // `start` after `stop` must not resurrect the loop: the context is closing and
    // its database handle is about to go with it.
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(logged).toHaveLength(sampledBeforeRestart);
  });
});
