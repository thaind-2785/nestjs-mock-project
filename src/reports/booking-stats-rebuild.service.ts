import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  bookingStatsRebuildDeleteBatchSize,
  bookingStatsRebuildErrorCodes,
} from './booking-stats.constants';
import {
  BOOKING_STATS_OFFSETS,
  type BookingStatsOffsets,
} from './booking-stats-offsets';
import type { BookingStatsRebuildResult } from './booking-stats.types';

/**
 * Empties the read model and rewinds its consumer group, so the next worker start
 * replays the whole topic into it (`SPEC-012` replay). It is how a changed statistic
 * definition reaches history: the version guard makes a plain replay a no-op, so the
 * rows have to go first.
 *
 * The order is deliberate. The offsets are rewound before any row is deleted: if the
 * delete then fails, the next run replays over rows that are still correct and the
 * command can simply be repeated, whereas deleting first and failing to rewind would
 * leave an empty table that the consumer, resuming from its old position, never refills.
 */
@Injectable()
export class BookingStatsRebuildService {
  private readonly logger = new Logger(BookingStatsRebuildService.name);

  constructor(
    private readonly database: DatabaseConnectionService,
    @Inject(BOOKING_STATS_OFFSETS)
    private readonly offsets: BookingStatsOffsets,
  ) {}

  async rebuild(): Promise<BookingStatsRebuildResult> {
    // First, before anything on the broker moves: the application context opens no
    // connection by itself, and a rewind followed by a database that cannot be reached
    // would leave the group replaying over a table nobody emptied.
    const dataSource = await this.database.ensureInitialized();
    // A reset under a live member is overwritten by that member's next commit, so a
    // running worker would make this command report success and change nothing.
    if (await this.offsets.hasActiveMembers()) {
      throw new Error(bookingStatsRebuildErrorCodes.consumerActive);
    }
    // Without the topic there is nothing to replay, and emptying the table would lose
    // numbers that cannot come back.
    if (!(await this.offsets.topicExists())) {
      throw new Error(bookingStatsRebuildErrorCodes.topicMissing);
    }
    await this.offsets.resetToEarliest();
    const factsDeleted = await this.deleteFacts(dataSource);
    // A worker started while the rows were going may have applied events into the
    // half-emptied table and committed past them; the replay would then never restore
    // those rows. Asked again, so that case fails loudly instead of exiting 0.
    if (await this.offsets.hasActiveMembers()) {
      throw new Error(bookingStatsRebuildErrorCodes.consumerJoined);
    }
    this.logger.log({ event: 'booking_stats_rebuilt', factsDeleted });
    return { factsDeleted };
  }

  /** Bounded batches, so the delete never holds a lock on the whole table at once. */
  private async deleteFacts(dataSource: DataSource): Promise<number> {
    let total = 0;
    for (;;) {
      const result: { affectedRows?: number } = await dataSource.query(
        'DELETE FROM booking_stats_facts ORDER BY booking_public_id LIMIT ?',
        [bookingStatsRebuildDeleteBatchSize],
      );
      const deleted = result.affectedRows ?? 0;
      total += deleted;
      if (deleted < bookingStatsRebuildDeleteBatchSize) return total;
    }
  }
}
