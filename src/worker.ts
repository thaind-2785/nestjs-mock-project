import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { bootstrapNotificationWorker } from './worker-bootstrap';
import { WorkerModule } from './worker.module';

void bootstrapNotificationWorker({
  createContext: () =>
    NestFactory.createApplicationContext(WorkerModule, {
      logger: new ConsoleLogger({ json: true }),
    }),
  onStopped: (drained) => {
    // Flush before leaving. `process.exit` discards whatever stdout still holds, and
    // on a pipe - a log collector, a redirect to a file - that is exactly the line
    // saying whether the drain finished. Exiting non-zero after an expired drain
    // tells a supervisor the process abandoned work rather than completing it, and
    // exiting explicitly bounds a drain that left a handle behind.
    process.exitCode = drained ? 0 : 1;
    process.stdout.write('', () => process.exit(drained ? 0 : 1));
  },
}).catch((error: unknown) => {
  // Reached when the context resolves and startup then fails. A configuration or DI
  // error is raised by Nest before this promise exists and is reported by its own
  // exception handler, so this is not the only way a start can fail.
  new Logger('NotificationWorker').error({
    event: 'notification_worker_start_failed',
    // Configuration failures name the variables at fault, never their values.
    reason: error instanceof Error ? error.message : 'WORKER_START_FAILED',
  });
  // Exiting explicitly: the relay's poll timer may already be holding the event loop
  // open, so an exit code alone would leave a failed worker running forever.
  process.exitCode = 1;
  process.stdout.write('', () => process.exit(1));
});
