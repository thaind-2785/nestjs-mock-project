import { INestApplicationContext, Logger, LoggerService } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import {
  describeNotificationsConfiguration,
  notificationsConfig,
} from './config/notifications.config';

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
      void stopNotificationWorker(context, {
        drainMs: configuration.worker.shutdownDrainMs,
        logger,
        signal,
      })
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
  });
  return context;
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
