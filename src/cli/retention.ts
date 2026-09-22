import { NestFactory } from '@nestjs/core';
import { parseRetentionArguments } from '../retention/retention.arguments';
import { RetentionOperationsModule } from '../retention/retention-operations.module';
import { RetentionReportService } from '../retention/retention-report.service';

/**
 * Reports what scheduled retention would delete, without deleting anything.
 *
 * Usage: `npm run ops:retention -- --dry-run [--task <name>]`
 *
 * `--dry-run` is required, because this build has no code path that deletes. The
 * deletions arrive in `P7-T03` and the schedule in `P7-T04`; until then this is how the
 * due predicates get read against real data, which is the point of shipping the
 * deciding half of a destructive job before the acting half.
 *
 * The output is one line per task: how many rows are waiting, and how old the oldest
 * one is. Those two together are the reading - a large young backlog is a busy night,
 * a small old one is a task that is not running at all.
 */
async function main(): Promise<void> {
  const request = parseRetentionArguments(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(
    RetentionOperationsModule,
    { logger: ['error'] },
  );
  try {
    const reports = await application
      .get(RetentionReportService)
      .report(request.taskName);
    for (const report of reports) {
      process.stdout.write(
        `retention:dry-run task=${report.taskName} table=${report.table} ` +
          `due=${report.dueCount} oldestDueAgeMs=${report.oldestDueAgeMs}\n`,
      );
    }
  } finally {
    await application.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'RETENTION_REPORT_FAILED'}\n`,
  );
  process.exitCode = 1;
});
