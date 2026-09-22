import { NestFactory } from '@nestjs/core';
import { parseRetentionArguments } from '../retention/retention.arguments';
import { RetentionOperationsModule } from '../retention/retention-operations.module';
import { RetentionReportService } from '../retention/retention-report.service';
import { RetentionRunService } from '../retention/retention-run.service';

/**
 * Runs scheduled retention by hand, or reports what it would do.
 *
 * Usage:
 *   `npm run ops:retention -- --dry-run [--task <name>]`
 *   `npm run ops:retention -- [--task <name>] [--batch-size <n>]`
 *
 * The dry run reports and touches nothing; without it the command deletes. Both claim
 * nothing the scheduler would not: a real run takes today's window through the same
 * ledger election, so running it twice in a day is refused rather than repeated, and
 * `P7-T04` will find the window already done.
 *
 * A run that reports `budgetSpent` stopped with work still waiting. That is not a
 * failure - the remainder is still due, and the next run continues from the same query.
 */
async function main(): Promise<void> {
  const request = parseRetentionArguments(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(
    RetentionOperationsModule,
    // The run logs what it did, and that record is the point of invoking it by hand.
    { logger: request.dryRun ? ['error'] : ['error', 'warn', 'log'] },
  );
  try {
    if (request.dryRun) {
      const reports = await application
        .get(RetentionReportService)
        .report(request.taskName);
      for (const report of reports) {
        process.stdout.write(
          `retention:dry-run task=${report.taskName} table=${report.table} ` +
            `windowHours=${report.windowHours} due=${report.dueCount} ` +
            `oldestOverdueMs=${report.oldestOverdueMs}\n`,
        );
      }
      return;
    }

    const service = application.get(RetentionRunService);
    const outcomes = request.taskName
      ? [await service.runTask(request.taskName, request.batchSize)]
      : await service.runAll(request.batchSize);

    let failed = false;
    for (const outcome of outcomes) {
      failed = failed || outcome.outcome === 'failed';
      process.stdout.write(
        `retention:run task=${outcome.taskName} outcome=${outcome.outcome}` +
          `${outcome.reason ? ` reason=${outcome.reason}` : ''} ` +
          `batches=${outcome.batches} budgetSpent=${outcome.budgetSpent} ` +
          `deleted=${JSON.stringify(outcome.counts)}` +
          `${outcome.errorCode ? ` errorCode=${outcome.errorCode}` : ''}\n`,
      );
    }
    // A refusal is not a failure: losing today's window to another replica, or to an
    // earlier run of this command, is the singleton working. A task that actually
    // failed has to stop a script that runs this in a loop.
    if (failed) process.exitCode = 1;
  } finally {
    await application.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'RETENTION_COMMAND_FAILED'}\n`,
  );
  process.exitCode = 1;
});
