import { INestApplicationContext } from '@nestjs/common';
import {
  createNotificationsConfiguration,
  notificationsConfig,
} from './config/notifications.config';
import {
  createReportsConfiguration,
  reportsConfig,
} from './config/reports.config';
import {
  createRetentionConfiguration,
  retentionConfig,
} from './config/retention.config';
import { validateEnvironment } from './config/environment.validation';
import {
  bootstrapNotificationWorker,
  workerDrainMs,
  WorkerShutdownSignal,
  WorkerSignalTarget,
} from './worker-bootstrap';

class FakeSignals implements WorkerSignalTarget {
  private readonly listeners = new Map<WorkerShutdownSignal, () => void>();

  once(signal: WorkerShutdownSignal, listener: () => void): this {
    this.listeners.set(signal, listener);
    return this;
  }

  // Faithful to `process.once`: the listener is removed as it fires, so a repeated
  // signal finds no handler. A fake that kept it would let a test claim a guard the
  // real runtime never reaches.
  emit(signal: WorkerShutdownSignal): void {
    const listener = this.listeners.get(signal);
    this.listeners.delete(signal);
    listener?.();
  }

  get registered(): WorkerShutdownSignal[] {
    return [...this.listeners.keys()];
  }
}

function createContextDouble(
  close: () => Promise<void>,
  environment: Record<string, string> = {},
) {
  const variables = validateEnvironment({
    NOTIFICATION_SHUTDOWN_DRAIN_MS: '30000',
    ...environment,
  });
  // Every family this process hosts, because the drain it takes is the largest of them
  // and a double that answered only some would let the bootstrap read `undefined`. That
  // is not hypothetical: retention arrived as the third and these cases failed loudly,
  // which is the whole reason the double answers all of them rather than the one under
  // test.
  const configuration = createNotificationsConfiguration(variables);
  const reports = createReportsConfiguration(variables);
  const retention = createRetentionConfiguration(variables);
  const closed = jest.fn(close);
  return {
    closed,
    context: {
      close: closed,
      get: jest.fn((token: unknown) => {
        if (token === notificationsConfig.KEY) return configuration;
        if (token === reportsConfig.KEY) return reports;
        if (token === retentionConfig.KEY) return retention;
        return undefined;
      }),
    } as unknown as INestApplicationContext,
  };
}

function createStopSignal() {
  let resolveStopped: (drained: boolean) => void = () => undefined;
  const stopped = new Promise<boolean>((resolve) => {
    resolveStopped = resolve;
  });
  return { stopped, onStopped: (drained: boolean) => resolveStopped(drained) };
}

describe('bootstrapNotificationWorker', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs the resolved transport and binds both shutdown signals', async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const signals = new FakeSignals();

    await bootstrapNotificationWorker({
      createContext: () =>
        Promise.resolve(createContextDouble(() => Promise.resolve()).context),
      logger,
      signals,
    });

    expect(signals.registered).toEqual(['SIGTERM', 'SIGINT']);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification_worker_started',
        provider: 'MAILPIT',
        queueName: 'email-delivery',
      }),
    );
  });

  it('closes the context on a signal and reports a completed drain', async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const signals = new FakeSignals();
    const { context, closed } = createContextDouble(() => Promise.resolve());
    const { stopped, onStopped } = createStopSignal();

    await bootstrapNotificationWorker({
      createContext: () => Promise.resolve(context),
      logger,
      signals,
      onStopped,
    });
    signals.emit('SIGTERM');

    await expect(stopped).resolves.toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification_worker_stopped',
        signal: 'SIGTERM',
        drained: true,
      }),
    );
  });

  it('gives up on a close that outlives the configured drain', async () => {
    jest.useFakeTimers();
    const logger = { log: jest.fn(), error: jest.fn() };
    const signals = new FakeSignals();
    const { stopped, onStopped } = createStopSignal();

    await bootstrapNotificationWorker({
      createContext: () =>
        Promise.resolve(
          createContextDouble(() => new Promise<void>(() => undefined)).context,
        ),
      logger,
      signals,
      onStopped,
    });
    signals.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(stopped).resolves.toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification_worker_stopped',
        drained: false,
        drainMs: 30_000,
      }),
    );
  });

  it('drains on the export bound once this process hosts exports', async () => {
    jest.useFakeTimers();
    const logger = { log: jest.fn(), error: jest.fn() };
    const signals = new FakeSignals();
    const { stopped, onStopped } = createStopSignal();

    await bootstrapNotificationWorker({
      createContext: () =>
        Promise.resolve(
          createContextDouble(() => new Promise<void>(() => undefined), {
            REPORT_EXPORT_ENABLED: 'true',
          }).context,
        ),
      logger,
      signals,
      onStopped,
    });
    signals.emit('SIGTERM');
    // The mail family's own bound has passed and nothing has given up: an export
    // generation is bounded at 60 seconds, so draining at 30 would kill a Worker
    // Thread that was about to succeed on every ordinary deploy.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(logger.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification_worker_stopped' }),
    );

    await jest.advanceTimersByTimeAsync(60_000);

    await expect(stopped).resolves.toBe(false);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification_worker_stopped',
        drained: false,
        drainMs: 90_000,
      }),
    );
  });

  it('reports a stop that failed rather than leaving an unhandled rejection', async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const signals = new FakeSignals();
    const { context } = createContextDouble(() =>
      Promise.reject(new Error('CLOSE_FAILED')),
    );
    const { stopped, onStopped } = createStopSignal();

    await bootstrapNotificationWorker({
      createContext: () => Promise.resolve(context),
      logger,
      signals,
      onStopped,
    });
    signals.emit('SIGTERM');

    // A supervisor still gets the drained/not-drained answer, and the process still
    // sets an exit code, when a provider's close rejects.
    await expect(stopped).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification_worker_stop_failed',
        signal: 'SIGTERM',
      }),
    );
  });

  it('drains once when a different signal arrives during the drain', async () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const signals = new FakeSignals();
    const { context, closed } = createContextDouble(() => Promise.resolve());
    const drains = jest.fn();
    const { stopped, onStopped } = createStopSignal();

    await bootstrapNotificationWorker({
      createContext: () => Promise.resolve(context),
      logger,
      signals,
      onStopped: (drained) => {
        drains(drained);
        onStopped(drained);
      },
    });
    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await stopped;

    expect(closed).toHaveBeenCalledTimes(1);
    expect(drains).toHaveBeenCalledTimes(1);
  });
});

describe('workerDrainMs', () => {
  function configurations(environment: Record<string, string>) {
    const variables = validateEnvironment({
      NOTIFICATION_SHUTDOWN_DRAIN_MS: '30000',
      ...environment,
    });
    return [
      createNotificationsConfiguration(variables),
      createReportsConfiguration(variables),
      createRetentionConfiguration(variables),
    ] as const;
  }

  it('leaves a mail-only worker on the mail bound', () => {
    // No consumer is registered, so there is no generation to protect and no reason
    // to make every restart wait for work this process cannot be doing.
    const [notifications, reports, retention] = configurations({});

    expect(reports.enabled).toBe(false);
    expect(retention.enabled).toBe(false);
    expect(workerDrainMs(notifications, reports, retention)).toBe(30_000);
  });

  it('takes the larger bound once both families are hosted', () => {
    const [notifications, reports, retention] = configurations({
      REPORT_EXPORT_ENABLED: 'true',
    });

    expect(workerDrainMs(notifications, reports, retention)).toBe(
      reports.worker.shutdownDrainMs,
    );
  });

  it('never shortens the mail bound to the export one', () => {
    const [notifications, reports, retention] = configurations({
      REPORT_EXPORT_ENABLED: 'true',
      NOTIFICATION_SHUTDOWN_DRAIN_MS: '120000',
    });

    expect(workerDrainMs(notifications, reports, retention)).toBe(120_000);
  });

  it('covers a retention batch once the scheduler is hosted', () => {
    const [notifications, reports, retention] = configurations({
      RETENTION_ENABLED: 'true',
    });

    // One batch, not one run. The run is interruptible and hands its window back, so a
    // deploy never waits for a whole budget - which would be five minutes per task.
    expect(retention.run.shutdownDrainMs).toBeLessThan(
      retention.run.runBudgetMs,
    );
    expect(workerDrainMs(notifications, reports, retention)).toBe(
      retention.run.shutdownDrainMs,
    );
  });

  it('adds nothing for a family this process is not hosting', () => {
    // A switched-off family has no work to drain, and counting it would make every
    // deploy wait for something that cannot be happening.
    const [notifications, reports, retention] = configurations({
      RETENTION_ENABLED: 'false',
      NOTIFICATION_SHUTDOWN_DRAIN_MS: '15000',
    });

    expect(workerDrainMs(notifications, reports, retention)).toBe(15_000);
  });
});
