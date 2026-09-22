import { INestApplicationContext, Logger, LoggerService } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  describeNotificationsConfiguration,
  notificationsConfig,
} from './config/notifications.config';
import { reportsConfig } from './config/reports.config';
import { retentionConfig } from './config/retention.config';

export const workerShutdownSignals = ['SIGTERM', 'SIGINT'] as const;

export type WorkerShutdownSignal = (typeof workerShutdownSignals)[number];

export interface WorkerSignalTarget {
  once(signal: WorkerShutdownSignal, listener: () => void): unknown;
}

export type WorkerLogger = Pick<LoggerService, 'log' | 'error'>;

export interface NotificationWorkerOptions {
  createContext: () => Promise<INestApplicationContext>;
  logger?: WorkerLogger;
  signals?: WorkerSignalTarget;
  onStopped?: (drained: boolean) => void;
}

/**
 * Starts the worker context and binds its own signal handlers.
 *
 * Nest's `enableShutdownHooks` would close on a signal too, but without a bound: a
 * provider call that never settles would hold the process open for as long as the
 * socket does. Shutdown is owned here so the drain honours the configured bound and
 * reports whether the work actually finished.
 */
export async function bootstrapNotificationWorker(
  options: NotificationWorkerOptions,
): Promise<INestApplicationContext> {
  const logger = options.logger ?? new Logger('NotificationWorker');
  const signals = options.signals ?? process;
  const context = await options.createContext();
  const configuration = context.get<ConfigType<typeof notificationsConfig>>(
    notificationsConfig.KEY,
  );
  const drainMs = workerDrainMs(
    configuration,
    context.get<ConfigType<typeof reportsConfig>>(reportsConfig.KEY),
    context.get<ConfigType<typeof retentionConfig>>(retentionConfig.KEY),
  );

  let stopping = false;
  for (const signal of workerShutdownSignals) {
    // `once` leaves the default disposition in place after it fires, so a repeat of
    // the same signal force-quits a drain in progress. That is the conventional
    // meaning of a second SIGTERM and is deliberate. The guard below covers the other
    // case: SIGINT arriving after SIGTERM must not start a second drain, because the
    // first already owns the context and is already bounded.
    signals.once(signal, () => {
      if (stopping) return;
      stopping = true;
      void stopNotificationWorker(context, { drainMs, logger, signal })
        .then((drained) => options.onStopped?.(drained))
        .catch((error: unknown) => {
          // A close that rejects must still produce the stopped signal this module
          // exists to give a supervisor. Without this the process would report an
          // unhandled rejection and never set its exit code - and every provider
          // the later slices add (BullMQ, Redis, SMTP) closes over a network.
          logger.error({
            event: 'notification_worker_stop_failed',
            signal,
            reason:
              error instanceof Error ? error.message : 'WORKER_STOP_FAILED',
          });
          options.onStopped?.(false);
        });
    });
  }

  logger.log({
    event: 'notification_worker_started',
    ...describeNotificationsConfiguration(configuration),
    // Separate from the notification family's own `shutdownDrainMs` in the summary
    // above, which is one input to it rather than the bound the process will use.
    processDrainMs: drainMs,
  });
  return context;
}

/**
 * The drain this process gets: the largest of the families it actually hosts.
 *
 * One process hosts two independent families with two different bounded units of work,
 * and only one number can be the drain. The mail family's 30 seconds is sized for a
 * single provider send; an export attempt holds a Worker Thread for up to a bounded 60
 * seconds, so draining on the mail bound alone would `SIGKILL` a generation that was
 * about to succeed on every ordinary deploy - and it would do so while
 * `assertRoomExportBounds` was still checking the export drain against the generation
 * timeout, because nothing read the value it was checking.
 *
 * The export bound only counts when exports are enabled. A deployment that has not
 * turned them on registers no consumer and has no generation to protect, and giving it
 * the longer drain would make every restart of a mail-only worker wait for work it
 * cannot be doing.
 */
export function workerDrainMs(
  notifications: ConfigType<typeof notificationsConfig>,
  reports: ConfigType<typeof reportsConfig>,
  retention: ConfigType<typeof retentionConfig>,
): number {
  // The maximum across the families this process actually hosts. A family that is
  // switched off contributes nothing, because it has no work to drain - and including it
  // would make every deploy wait for a drain nobody needs.
  //
  // Retention contributes one batch rather than one run: its run is interruptible and
  // hands the window back, so shutdown never waits for a whole budget.
  return Math.max(
    notifications.worker.shutdownDrainMs,
    reports.enabled ? reports.worker.shutdownDrainMs : 0,
    retention.enabled ? retention.run.shutdownDrainMs : 0,
  );
}

export interface NotificationWorkerStopOptions {
  drainMs: number;
  logger: WorkerLogger;
  signal?: WorkerShutdownSignal;
}

/**
 * Closes the context within `drainMs` and resolves to whether it finished. A false
 * result is real information for an operator: an in-flight message may have been
 * accepted by the provider without its result reaching MySQL, which is exactly the
 * at-least-once window the delivery design documents.
 */
export async function stopNotificationWorker(
  context: INestApplicationContext,
  options: NotificationWorkerStopOptions,
): Promise<boolean> {
  const startedAt = Date.now();
  const drained = await closeWithin(context, options.drainMs);
  options.logger.log({
    event: 'notification_worker_stopped',
    signal: options.signal,
    drained,
    drainMs: options.drainMs,
    durationMs: Date.now() - startedAt,
  });
  return drained;
}

async function closeWithin(
  context: INestApplicationContext,
  drainMs: number,
): Promise<boolean> {
  let drainTimer: NodeJS.Timeout | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    drainTimer = setTimeout(() => resolve(false), drainMs);
    // The bound must not be the reason the process stays alive.
    drainTimer.unref();
  });
  try {
    return await Promise.race([context.close().then(() => true), expiry]);
  } finally {
    clearTimeout(drainTimer);
  }
}
