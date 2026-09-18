import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { notificationsConfig } from '../config/notifications.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { notificationBackoffMs } from './notification-backoff';
import { notificationEventTypes } from './notification-event';
import {
  notificationJobName,
  notificationQueueUnavailableCode,
} from './outbox-dispatcher.constants';
import type {
  DispatchResult,
  NotificationJobData,
} from './outbox-dispatcher.types';
import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_QUEUE_CLIENT,
} from './notification.tokens';
import { claimBatchIsolation } from '../common/outbox/outbox-claim.constants';
import { OutboxPollLoop } from '../common/outbox/outbox-poll-loop';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import type { OutboxClaim } from '../common/outbox/outbox-claim.types';

/**
 * Moves durable outbox events onto the delivery queue.
 *
 * MySQL is the source of truth and the schedule; BullMQ is transport. The claim
 * commits before any Redis call, so a dispatcher that dies mid-handoff leaves an
 * expiring lease another dispatcher recovers, and a queue that refuses a job hands
 * the claim straight back with its next retry time. Jobs carry `attempts: 1` because
 * a second retry mechanism would multiply deliveries rather than space them.
 */
@Injectable()
export class OutboxDispatcherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private readonly loop = new OutboxPollLoop(
    () => this.pollOnce(),
    () => this.configuration.relay.pollIntervalMs,
  );

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly claims: OutboxClaimRepository,
    @Inject(NOTIFICATION_QUEUE) private readonly queue: Queue,
    @Inject(NOTIFICATION_QUEUE_CLIENT) private readonly queueClient: Redis,
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
    await this.queue.close();
    // BullMQ marks a connection it did not create as shared and leaves it open, so
    // closing the queue is not closing the socket.
    await this.queueClient.quit();
  }

  start(): void {
    this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  async runOnce(): Promise<DispatchResult> {
    const dataSource = await this.database.ensureInitialized();
    const claimToken = randomUUID();
    const { relay } = this.configuration;
    const claims = await dataSource.transaction(
      claimBatchIsolation,
      (manager) =>
        this.claims.claimBatch(manager, {
          // This dispatcher delivers mail and claims mail. The export dispatcher
          // reads the same table with its own allowlist, and neither can lease the
          // other's rows because the restriction is in the claiming statement.
          eventTypes: notificationEventTypes,
          batchSize: relay.claimBatchSize,
          leaseMs: relay.claimLeaseMs,
          claimToken,
        }),
    );
    if (claims.length === 0) return { claimed: 0, queued: 0, released: 0 };

    // The claim transaction has committed. Only now is Redis allowed to matter.
    let queued = 0;
    let released = 0;
    for (const claim of claims) {
      if (await this.enqueue(claim, claimToken)) {
        queued += 1;
        continue;
      }
      if (await this.releaseClaim(claim, claimToken)) released += 1;
    }
    return { claimed: claims.length, queued, released };
  }

  private async enqueue(
    claim: OutboxClaim,
    claimToken: string,
  ): Promise<boolean> {
    const data: NotificationJobData = {
      outboxEventId: claim.id,
      claimToken,
      attempt: claim.attempt,
    };
    try {
      await this.queue.add(notificationJobName, data, {
        // One job per claim. A retry of the same event is a new attempt and so a new
        // id, while a repeat of this exact handoff is deduplicated by BullMQ.
        jobId: `${claim.id}-${claim.attempt}`,
        attempts: 1,
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      });
      return true;
    } catch (error: unknown) {
      this.logger.error({
        event: 'notification_queue_handoff_failed',
        outboxEventId: claim.id,
        attempt: claim.attempt,
        reason: error instanceof Error ? error.name : 'QUEUE_ADD_FAILED',
      });
      return false;
    }
  }

  private async releaseClaim(
    claim: OutboxClaim,
    claimToken: string,
  ): Promise<boolean> {
    const { relay } = this.configuration;
    try {
      const dataSource = await this.database.ensureInitialized();
      return await dataSource.transaction((manager) =>
        this.claims.release(manager, {
          eventTypes: notificationEventTypes,
          id: claim.id,
          claimToken,
          attempt: claim.attempt,
          retryInMs: notificationBackoffMs(claim.attempt, {
            initialMs: relay.backoffInitialMs,
            maxMs: relay.backoffMaxMs,
          }),
          errorCode: notificationQueueUnavailableCode,
        }),
      );
    } catch (error: unknown) {
      // The lease is the backstop: an unreleased claim is recovered when it expires,
      // so a failed release costs latency, never the event.
      this.logger.error({
        event: 'notification_claim_release_failed',
        outboxEventId: claim.id,
        attempt: claim.attempt,
        reason: error instanceof Error ? error.name : 'CLAIM_RELEASE_FAILED',
      });
      return false;
    }
  }

  private async pollOnce(): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.runOnce();
      if (result.claimed === 0) return;
      this.logger.log({
        event: 'notification_batch_dispatched',
        ...result,
        // Claims that were neither queued nor handed back: their release lost a race
        // with the lease recovering elsewhere. Harmless, but silent otherwise.
        stranded: result.claimed - result.queued - result.released,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      // A poll that cannot reach MySQL must not end the loop: the next tick retries,
      // and every claim it had already committed is protected by its lease.
      this.logger.error({
        event: 'notification_poll_failed',
        reason: error instanceof Error ? error.name : 'POLL_FAILED',
        durationMs: Date.now() - startedAt,
      });
    }
  }
}
