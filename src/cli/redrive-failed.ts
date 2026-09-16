import { NestFactory } from '@nestjs/core';
import { NotificationOperationsModule } from '../notifications/notification-operations.module';
import { parseRedriveArguments } from '../notifications/notification-redrive.arguments';
import { NotificationRedriveService } from '../notifications/notification-redrive.service';

/**
 * Returns one terminally failed notification to the pipeline after its cause is
 * fixed.
 *
 * Usage: `npm run notifications:redrive-failed -- --event-id <uuid> --reason <text>`
 * Add `--allow-duplicate` only when the guest has confirmed that a message the
 * provider already accepted never arrived; without it a recorded acceptance is
 * refused.
 *
 * A refusal exits non-zero. The state machine's "no" has to stop a script that runs
 * this in a loop, not scroll past as a success.
 */
async function main(): Promise<void> {
  const request = parseRedriveArguments(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(
    NotificationOperationsModule,
    // The audit line the service emits is the point of the command, so `log` stays
    // enabled here where the other CLIs keep only `error`.
    { logger: ['error', 'warn', 'log'] },
  );
  try {
    const result = await application
      .get(NotificationRedriveService)
      .redrive(request);
    process.stdout.write(
      `notifications-redrive:applied=${result.applied} code=${result.code} ` +
        `observedStatus=${result.observedEventStatus ?? 'NONE'} ` +
        `deliveriesReset=${result.deliveriesReset}\n`,
    );
    if (!result.applied) process.exitCode = 1;
  } finally {
    await application.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'NOTIFICATION_REDRIVE_FAILED'}\n`,
  );
  process.exitCode = 1;
});
