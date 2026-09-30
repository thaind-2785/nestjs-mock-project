import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { claimBatchIsolation } from '../common/outbox/outbox-claim.constants';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import { OutboxPollLoop } from '../common/outbox/outbox-poll-loop';
import { bookingStreamConfig } from '../config/booking-stream.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  bookingLifecycleErrorCodes,
  bookingLifecycleEventTypes,
} from './booking-lifecycle-event.constants';
import { toBookingLifecycleMessage } from './booking-lifecycle-message';
import {
  BookingLifecyclePayloadError,
  parseBookingLifecyclePayload,
} from './booking-lifecycle-payload';
import {
  BOOKING_LIFECYCLE_PUBLISHER,
  type BookingLifecyclePublisher,
} from './booking-lifecycle-publisher';
import { BookingLifecycleRelayRepository } from './booking-lifecycle-relay.repository';
import type {
  BookingLifecycleMessage,
  BookingLifecycleRelayResult,
  ClaimedLifecycleRow,
} from './booking-lifecycle-relay.types';

/**
 * Moves committed lifecycle rows from the outbox onto the Kafka topic.
 *
 * A cycle is: claim a batch of this family only, commit the claim, read the claimed
 * payloads back, validate them, publish the valid ones in one request, then finalize
 * each outcome with one statement. The claim commits before Kafka is contacted, so a
 * relay that dies mid-publish leaves an expiring lease rather than an orphaned row.
 *
 * The publisher is `null` while the stream is disabled, and then this service starts
 * no loop at all: a disabled worker opens no Kafka connection and claims nothing.
 */
@Injectable()
export class BookingLifecycleRelayService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(BookingLifecycleRelayService.name);
  private readonly loop = new OutboxPollLoop(
    () => this.pollOnce(),
    () => this.configuration.relay.pollIntervalMs,
  );

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly claims: OutboxClaimRepository,
    private readonly rows: BookingLifecycleRelayRepository,
    @Inject(BOOKING_LIFECYCLE_PUBLISHER)
    private readonly publisher: BookingLifecyclePublisher | null,
    @Inject(bookingStreamConfig.KEY)
    private readonly configuration: ConfigType<typeof bookingStreamConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.publisher) this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
    await this.publisher?.close();
  }

  async runOnce(): Promise<BookingLifecycleRelayResult> {
    const empty = { claimed: 0, published: 0, retried: 0, failed: 0 };
    if (!this.publisher) return empty;
    const dataSource = await this.database.ensureInitialized();
    const claimToken = randomUUID();
    const { relay } = this.configuration;
    const claims = await dataSource.transaction(
      claimBatchIsolation,
      (manager) =>
        this.claims.claimBatch(manager, {
          eventTypes: bookingLifecycleEventTypes,
          batchSize: relay.claimBatchSize,
          leaseMs: relay.claimLeaseMs,
          claimToken,
        }),
    );
    if (claims.length === 0) return empty;

    // The claim has committed. Only now may the broker matter.
    const claimed = await this.rows.readClaimed(dataSource.manager, {
      ids: claims.map((claim) => claim.id),
      claimToken,
    });
    const { messages, publishable, invalid } = this.prepare(claimed);

    const failed = await this.rows.markFailed(dataSource.manager, {
      ids: invalid,
      claimToken,
      errorCode: bookingLifecycleErrorCodes.invalid,
    });
    if (publishable.length === 0) {
      return { ...empty, claimed: claims.length, failed };
    }

    try {
      await this.publisher.publish(messages);
    } catch (error: unknown) {
      this.logger.error({
        event: 'booking_lifecycle_publish_failed',
        count: publishable.length,
        reason: error instanceof Error ? error.name : 'PUBLISH_FAILED',
      });
      const retried = await this.rows.markRetry(dataSource.manager, {
        ids: publishable,
        claimToken,
        backoffInitialMs: relay.backoffInitialMs,
        backoffMaxMs: relay.backoffMaxMs,
        errorCode: bookingLifecycleErrorCodes.publishFailed,
      });
      return { ...empty, claimed: claims.length, retried, failed };
    }

    const published = await this.rows.markPublished(dataSource.manager, {
      ids: publishable,
      claimToken,
    });
    return { claimed: claims.length, published, retried: 0, failed };
  }

  /**
   * Splits a claimed batch into what may be published and what never will be. An
   * invalid row does not hold the rest of the batch back: it is a programming error in
   * one event, not a reason to stop the stream.
   */
  private prepare(rows: readonly ClaimedLifecycleRow[]): {
    messages: BookingLifecycleMessage[];
    publishable: string[];
    invalid: string[];
  } {
    const messages: BookingLifecycleMessage[] = [];
    const publishable: string[] = [];
    const invalid: string[] = [];
    for (const row of rows) {
      try {
        const payload = parseBookingLifecyclePayload(row.payload);
        messages.push(toBookingLifecycleMessage(row, payload));
        publishable.push(row.id);
      } catch (error: unknown) {
        if (!(error instanceof BookingLifecyclePayloadError)) throw error;
        invalid.push(row.id);
        this.logger.error({
          event: 'booking_lifecycle_event_invalid',
          outboxEventId: row.id,
          errorCode: error.code,
          // The field path is schema metadata; no payload value is in the message.
          field: error.message,
        });
      }
    }
    return { messages, publishable, invalid };
  }

  private async pollOnce(): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.runOnce();
      if (result.claimed === 0) return;
      this.logger.log({
        event: 'booking_lifecycle_batch_published',
        ...result,
        // Claims no outcome statement matched: their lease expired and another relay
        // recovered them. At-least-once makes this harmless, but it is worth seeing.
        stranded:
          result.claimed - result.published - result.retried - result.failed,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      // A cycle that cannot reach MySQL must not end the loop; its committed claims
      // are protected by their lease.
      this.logger.error({
        event: 'booking_lifecycle_poll_failed',
        reason: error instanceof Error ? error.name : 'POLL_FAILED',
        durationMs: Date.now() - startedAt,
      });
    }
  }
}
