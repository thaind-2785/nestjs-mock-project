import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { OutboxEventStatus } from '../bookings/entities/booking.enums';
import { notificationsConfig } from '../config/notifications.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { backlogSampleFailedCode } from './notification-backlog.constants';
import { NotificationBacklogRepository } from './notification-backlog.repository';
import type {
  NotificationBacklogSnapshot,
  QueueBacklogCounts,
} from './notification-backlog.types';
import { NOTIFICATION_QUEUE } from './notification.tokens';

/**
 * Driver errors carry a stable `code` (`ER_LOCK_WAIT_TIMEOUT`, `ECONNREFUSED`, ...);
 * everything else degrades to one constant rather than to a class name.
 */
function backlogFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0
    ? code
    : backlogSampleFailedCode;
}

/**
 * Publishes the backlog an operator alerts on.
 *
 * Nothing in the delivery path reads this. It exists because the pipeline's failure
 * modes are quiet ones - a lease that stops being recovered, a template that starts
 * failing, a queue nobody is draining - and each of them shows up as a count that
 * stops moving rather than as an error anyone logs. The sample is therefore emitted
 * on a fixed interval whether or not anything changed: an alert on "oldest pending
 * age" needs the sample that says the age is still growing, and a sample suppressed
 * because it looked the same as the last one is exactly the sample that matters.
 */
@Injectable()
export class NotificationBacklogService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(NotificationBacklogService.name);
  private timer: NodeJS.Timeout | undefined;
  private sample: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly backlog: NotificationBacklogRepository,
    @Inject(NOTIFICATION_QUEUE) private readonly queue: Queue,
    @Inject(notificationsConfig.KEY)
    private readonly configuration: ConfigType<typeof notificationsConfig>,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.timer || this.sample || this.stopping) return;
    // The first sample is immediate. A worker that has just started is exactly when
    // an operator wants to see the backlog it inherited, not one interval later.
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // A sample in flight is a read-only aggregate; waiting for it costs one query and
    // keeps the drain from racing a logger that is about to be torn down.
    await this.sample;
  }

  async runOnce(): Promise<void> {
    const startedAt = Date.now();
    const dataSource = await this.database.ensureInitialized();
    const snapshot = await this.backlog.read(dataSource.manager);
    this.logger.log({
      event: 'notification_backlog_sampled',
      provider: this.configuration.transport.provider,
      ...this.summarize(snapshot),
      queue: await this.readQueueCounts(),
      durationMs: Date.now() - startedAt,
    });
  }

  /**
   * The snapshot carries event types, template keys, statuses, and counts. Every one
   * of those is a value this repository defines, so the emitted line holds no address,
   * no subject, no booking detail, and nothing an operator's log shipper has to
   * redact.
   */
  private summarize(snapshot: NotificationBacklogSnapshot): {
    outbox: NotificationBacklogSnapshot['outbox'];
    deliveries: NotificationBacklogSnapshot['deliveries'];
    leases: NotificationBacklogSnapshot['leases'];
    oldestPendingAgeMs: number;
  } {
    const pending = snapshot.outbox.filter(
      (entry) => entry.status === OutboxEventStatus.Pending,
    );
    return {
      outbox: snapshot.outbox,
      deliveries: snapshot.deliveries,
      // A claimed event is absent from the pending backlog whether or not anything is
      // still working on it, so a relay that stopped polling is invisible without
      // this: the events sit in PROCESSING and every pending number looks healthy.
      leases: snapshot.leases,
      // The single number most alerts are written against, lifted out of the grouped
      // rows so a threshold does not have to reduce an array.
      oldestPendingAgeMs: pending.reduce(
        (oldest, entry) => Math.max(oldest, entry.oldestAvailableAgeMs),
        0,
      ),
    };
  }

  private async readQueueCounts(): Promise<QueueBacklogCounts | null> {
    try {
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed',
      );
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      };
    } catch {
      // Redis being unreachable is already reported by the relay, and it must not
      // suppress the MySQL half of the sample: a queue outage is precisely when the
      // outbox backlog is the number worth seeing.
      return null;
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sample = this.sampleOnce().finally(() => {
        this.sample = undefined;
        if (!this.stopping) {
          this.schedule(
            this.configuration.observability.backlogSampleIntervalMs,
          );
        }
      });
    }, delayMs);
  }

  private async sampleOnce(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error: unknown) {
      // An observability failure must never end the loop or the process. The next
      // interval retries, and the absence of samples is itself the alert.
      this.logger.error({
        event: 'notification_backlog_sample_failed',
        // Every driver failure arrives as `QueryFailedError`, which tells an operator
        // paged by "no samples" nothing. The driver's own code is the stable
        // identifier that separates a lock-wait timeout from a dead connection.
        reason: backlogFailureCode(error),
      });
    }
  }
}
