import { NestFactory } from '@nestjs/core';
import {
  BOOKING_STATS_OFFSETS,
  type BookingStatsOffsets,
} from '../reports/booking-stats-offsets';
import { BookingStatsOperationsModule } from '../reports/booking-stats-operations.module';
import { BookingStatsRebuildService } from '../reports/booking-stats-rebuild.service';

/**
 * Rebuilds the booking statistics read model from the lifecycle topic.
 *
 * Usage: stop the worker, then `npm run reports:booking-stats:rebuild`, then start the
 * worker again; its consumer replays the topic into the emptied table.
 *
 * A refusal exits non-zero with a stable code, so a script cannot mistake "the worker
 * was still running" for a rebuild.
 */
async function main(): Promise<void> {
  const application = await NestFactory.createApplicationContext(
    BookingStatsOperationsModule,
    { logger: ['error', 'warn', 'log'] },
  );
  try {
    const result = await application.get(BookingStatsRebuildService).rebuild();
    process.stdout.write(
      `booking-stats-rebuild:factsDeleted=${result.factsDeleted}\n`,
    );
  } finally {
    await application.get<BookingStatsOffsets>(BOOKING_STATS_OFFSETS).close();
    await application.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'BOOKING_STATS_REBUILD_FAILED'}\n`,
  );
  process.exitCode = 1;
});
