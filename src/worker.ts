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
    // tells a supervisor the process abandoned work rather than completing it.
    process.exitCode = drained ? 0 : 1;
    process.stdout.write('', () => process.exit(drained ? 0 : 1));
  },
}).catch((error: unknown) => {
  new Logger('NotificationWorker').error({
    event: 'notification_worker_start_failed',
    // Configuration failures name the variables at fault, never their values.
    reason: error instanceof Error ? error.message : 'WORKER_START_FAILED',
  });
  process.exitCode = 1;
});
