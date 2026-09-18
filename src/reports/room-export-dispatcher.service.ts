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
import { claimBatchIsolation } from '../common/outbox/outbox-claim.constants';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import type { OutboxClaim } from '../common/outbox/outbox-claim.types';
import { OutboxPollLoop } from '../common/outbox/outbox-poll-loop';
import { reportsConfig } from '../config/reports.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { roomExportBackoffMs } from './room-export-backoff';
import {
  roomExportEventTypes,
  roomExportJobName,
  roomExportQueueUnavailableCode,
} from './room-export.constants';
import { ROOM_EXPORT_QUEUE, ROOM_EXPORT_QUEUE_CLIENT } from './report.tokens';
import type {
  RoomExportDispatchResult,
  RoomExportJobData,
} from './room-export-dispatcher.types';

/**
 * Moves durable export intents onto the export queue.
 *
 * MySQL is the source of truth and the schedule; BullMQ is transport. The claim commits
 * before any Redis call, so a dispatcher that dies mid-handoff leaves an expiring lease
 * another dispatcher recovers, and a queue that refuses a job hands the claim straight
 * back with its next retry time.
 */
@Injectable()
export class RoomExportDispatcherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RoomExportDispatcherService.name);
  private readonly loop = new OutboxPollLoop(
    () => this.pollOnce(),
    () => this.configuration.relay.pollIntervalMs,
  );

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly claims: OutboxClaimRepository,
    @Inject(ROOM_EXPORT_QUEUE) private readonly queue: Queue | null,
    @Inject(ROOM_EXPORT_QUEUE_CLIENT)
    private readonly queueClient: Redis | null,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    // Disabled means no polling at all, not polling that finds a null queue. The
    // rollout depends on a worker that can be deployed before it is allowed to work.
    if (!this.configuration.enabled) return;
    this.loop.start();
  }

  /**
   * The only place the producer and its socket are closed.
   *
   * It has to be this one rather than a lifecycle provider beside it, because the order
   * is load-bearing and Nest runs every shutdown hook of a module concurrently: a
   * second owner closing the queue would do it while a poll was still mid-handoff, and
   * an `add` against a closing queue is reported as a refusal that hands a perfectly
   * good claim back with a retry time. Stopping the loop first means there is no
   * in-flight handoff left to refuse.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
    await this.queue?.close();
    // BullMQ marks a connection it did not create as shared and leaves it open, so
    // closing the queue is not closing the socket.
    await this.queueClient?.quit();
  }

  async runOnce(): Promise<RoomExportDispatchResult> {
    if (!this.queue) return { claimed: 0, queued: 0, released: 0 };
    const dataSource = await this.database.ensureInitialized();
    const claimToken = randomUUID();
    const { relay } = this.configuration;
    const claims = await dataSource.transaction(
      claimBatchIsolation,
      (manager) =>
        this.claims.claimBatch(manager, {
          // This dispatcher generates workbooks and claims export events. The
          // notification dispatcher reads the same table with its own allowlist, and
          // neither can lease the other's rows.
          eventTypes: roomExportEventTypes,
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
    const data: RoomExportJobData = {
      outboxEventId: claim.id,
      claimToken,
      attempt: claim.attempt,
    };
    try {
      await this.queue?.add(roomExportJobName, data, {
        // One job per claim, identified by the token that claim was taken under rather
        // than by the attempt alone. The attempt is not unique across claims: a refused
        // handoff is released with `attempts = attempts - 1`, so the next claim of the
        // same event carries the same number. Without the token, an `add` that reached
        // Redis but lost its reply would be deduplicated against its own earlier job -
        // one still carrying the previous token, which no consumer can claim - and the
        // dispatcher would count a handoff that never happened as queued. With it, a
        // repeat of this exact handoff is still deduplicated and a new claim is not.
        jobId: `${claim.id}-${claim.attempt}-${claimToken}`,
        // MySQL owns the attempt budget. A second retry mechanism would multiply the
        // work rather than space it out.
        attempts: 1,
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      });
      return true;
    } catch (error: unknown) {
      this.logger.error({
        event: 'room_export_queue_handoff_failed',
        outboxEventId: claim.id,
        attempt: claim.attempt,
        reason: error instanceof Error ? error.name : 'QUEUE_ADD_FAILED',
      });
      return false;
    }
  }

  /**
   * Hands a claim back after the queue refused it, with the attempt returned too: a
   * job that never reached a worker is not an attempt, and an hour of Redis downtime
   * must not spend the whole budget of every waiting export.
   */
  private async releaseClaim(
    claim: OutboxClaim,
    claimToken: string,
  ): Promise<boolean> {
    const { relay } = this.configuration;
    try {
      const dataSource = await this.database.ensureInitialized();
      return await dataSource.transaction((manager) =>
        this.claims.release(manager, {
          eventTypes: roomExportEventTypes,
          id: claim.id,
          claimToken,
          attempt: claim.attempt,
          retryInMs: roomExportBackoffMs(claim.attempt, {
            initialMs: relay.backoffInitialMs,
            maxMs: relay.backoffMaxMs,
          }),
          errorCode: roomExportQueueUnavailableCode,
        }),
      );
    } catch (error: unknown) {
      this.logger.error({
        event: 'room_export_claim_release_failed',
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
        event: 'room_export_batch_dispatched',
        ...result,
        // Claims neither queued nor handed back: their release lost a race with the
        // lease recovering elsewhere. Harmless, but silent otherwise.
        stranded: result.claimed - result.queued - result.released,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      // A poll that cannot reach MySQL must not end the loop: the next tick retries,
      // and every claim it had already committed is protected by its lease.
      this.logger.error({
        event: 'room_export_poll_failed',
        reason: error instanceof Error ? error.name : 'POLL_FAILED',
        durationMs: Date.now() - startedAt,
      });
    }
  }
}
