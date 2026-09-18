import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { OutboxPollLoop } from '../common/outbox/outbox-poll-loop';
import { reportsConfig } from '../config/reports.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { ROOM_EXPORT_QUEUE } from './report.tokens';
import { RoomExportBacklogRepository } from './room-export-backlog.repository';
import type { RoomExportQueueBacklog } from './room-export-backlog.types';

/**
 * Publishes the export backlog an operator alerts on.
 *
 * Nothing in the export path reads it. It exists because this pipeline's failure modes
 * are quiet: a lease that stops being recovered, a cap administrators keep hitting, a
 * queue nobody is draining, an object nobody points at. Each shows up as a count that
 * stops moving rather than as an error anyone logs.
 *
 * The sample is emitted on a fixed interval whether or not anything changed. An alert
 * on "oldest queued age" needs the sample that says the age is still growing, and a
 * sample suppressed for looking like the last one is exactly the sample that matters.
 */
@Injectable()
export class RoomExportBacklogService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RoomExportBacklogService.name);
  private readonly loop = new OutboxPollLoop(
    () => this.sampleOnce(),
    () => this.configuration.observability.backlogSampleIntervalMs,
  );

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly backlog: RoomExportBacklogRepository,
    @Inject(ROOM_EXPORT_QUEUE) private readonly queue: Queue | null,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    // A disabled deployment has no consumer and no queue, so there is nothing to
    // sample and no connection to sample it over.
    if (!this.configuration.enabled) return;
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  private async sampleOnce(): Promise<void> {
    const startedAt = Date.now();
    try {
      const dataSource = await this.database.ensureInitialized();
      const snapshot = await this.backlog.read(dataSource.manager);
      this.logger.log({
        event: 'room_export_backlog_sampled',
        ...snapshot,
        queue: await this.readQueue(),
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      // A sampler that cannot reach MySQL must not end its own loop, and must never
      // affect an export: this is the one part of the module nothing depends on.
      this.logger.error({
        event: 'room_export_backlog_failed',
        reason: error instanceof Error ? error.name : 'BACKLOG_SAMPLE_FAILED',
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Redis counts beside the MySQL ones, because the two disagreeing is itself the
   * signal: durable work with an empty queue means handoffs are failing, and a queue
   * with no durable work behind it means jobs nothing can claim.
   */
  private async readQueue(): Promise<RoomExportQueueBacklog | undefined> {
    if (!this.queue) return undefined;
    try {
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
      );
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    } catch {
      // Reported as absent rather than as zero. Zero is a claim about the queue; this
      // is the absence of one, and an alert reading zeros as healthy would be wrong.
      return undefined;
    }
  }
}
