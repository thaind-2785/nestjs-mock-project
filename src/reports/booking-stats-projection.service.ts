import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { parseBookingLifecycleMessage } from '../bookings/booking-lifecycle-message';
import { BookingLifecyclePayloadError } from '../bookings/booking-lifecycle-payload';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  BOOKING_STATS_CONSUMER,
  type BookingStatsConsumer,
} from './booking-stats-consumer';
import { BookingStatsFactRepository } from './booking-stats-fact.repository';
import { toBookingStatsFact } from './booking-stats-fact.mapper';
import type {
  BookingStatsBatchResult,
  BookingStatsFactRow,
  ReceivedStatsMessage,
} from './booking-stats.types';

/**
 * Keeps `booking_stats_facts` in step with the lifecycle topic.
 *
 * One fetched batch becomes one transaction: parse, keep the newest version of each
 * booking, sort, upsert. The adapter commits the batch's offsets only after this
 * resolves, so a crash anywhere before the commit replays the batch - and the version
 * guard in the upsert makes that replay change nothing.
 *
 * The consumer is `null` while the stream is disabled, and then nothing starts.
 */
@Injectable()
export class BookingStatsProjectionService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BookingStatsProjectionService.name);

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly facts: BookingStatsFactRepository,
    @Inject(BOOKING_STATS_CONSUMER)
    private readonly consumer: BookingStatsConsumer | null,
  ) {}

  onApplicationBootstrap(): void {
    this.consumer?.start((messages) => this.applyBatch(messages));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }

  async applyBatch(
    messages: readonly ReceivedStatsMessage[],
  ): Promise<BookingStatsBatchResult> {
    const startedAt = Date.now();
    const newest = new Map<string, BookingStatsFactRow>();
    let skipped = 0;
    for (const message of messages) {
      const fact = this.toFact(message);
      if (!fact) {
        skipped += 1;
        continue;
      }
      // Within a batch only the newest version of a booking can survive the guard, so
      // the older ones are dropped here rather than written and then overwritten.
      const known = newest.get(fact.bookingPublicId);
      if (!known || fact.bookingVersion > known.bookingVersion) {
        newest.set(fact.bookingPublicId, fact);
      }
    }
    // One lock order for every statement: two batches upserting overlapping bookings
    // take their row locks in the same sequence and cannot deadlock each other.
    const rows = [...newest.values()].sort((left, right) =>
      left.bookingPublicId.localeCompare(right.bookingPublicId),
    );
    if (rows.length > 0) {
      const dataSource = await this.database.ensureInitialized();
      await dataSource.transaction((manager) =>
        this.facts.upsert(manager, rows),
      );
    }
    const result = { received: messages.length, applied: rows.length, skipped };
    this.logger.log({
      event: 'booking_stats_batch_applied',
      ...result,
      partition: messages[0]?.partition,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /**
   * A message that breaks the contract is skipped, not retried: it will break it the
   * same way every time, and holding its partition would stop every booking behind it.
   * Only the position is logged - the value may be anything.
   */
  private toFact(
    message: ReceivedStatsMessage,
  ): BookingStatsFactRow | undefined {
    try {
      return toBookingStatsFact(parseBookingLifecycleMessage(message.value));
    } catch (error: unknown) {
      if (!(error instanceof BookingLifecyclePayloadError)) throw error;
      this.logger.warn({
        event: 'booking_stats_message_skipped',
        partition: message.partition,
        offset: message.offset,
        errorCode: error.code,
      });
      return undefined;
    }
  }
}
