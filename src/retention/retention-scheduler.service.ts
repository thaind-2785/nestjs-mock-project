import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { retentionConfig } from '../config/retention.config';
import { OutboxPollLoop } from '../common/outbox/outbox-poll-loop';
import { RetentionRunService } from './retention-run.service';

/**
 * What makes retention happen without anybody asking.
 *
 * It is a tick, not a cron expression. A cron fires at a moment, and a replica that was
 * down at that moment never fires at all - so a deploy spanning midnight silently skips
 * a night, and nothing records that it was skipped because the run that would have
 * recorded it never started. This asks a question whose answer is still true at 00:07:
 * is the current window due and unclaimed. An outage delays retention instead of
 * cancelling it, and the ledger's unique key means asking twice costs nothing.
 *
 * Catch-up is bounded to the current window rather than replaying the missed ones. A
 * worker down for a week runs today once, not seven times: retention is idempotent by
 * predicate, so whatever was due last Tuesday is still due today, and replaying would
 * delete the same rows repeatedly across seven runs instead of one.
 *
 * The cost of a tick once the day's work is done is one failed insert and three
 * statements that match nothing, per task. That is deliberate - the alternative is a
 * process-local memory of what it already finished, which is state that can be wrong
 * about a window another replica owns.
 */
@Injectable()
export class RetentionSchedulerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RetentionSchedulerService.name);
  private stopping = false;
  private readonly loop = new OutboxPollLoop(
    () => this.tick(),
    () => this.configuration.run.tickIntervalMs,
  );

  constructor(
    private readonly runs: RetentionRunService,
    @Inject(retentionConfig.KEY)
    private readonly configuration: ConfigType<typeof retentionConfig>,
  ) {}

  onApplicationBootstrap(): void {
    // Disabled means no ticking at all, not ticking that finds nothing to do. The
    // rollout depends on a worker that can be deployed before it is allowed to delete.
    if (!this.configuration.enabled) {
      this.logger.log({ event: 'retention_scheduler_disabled' });
      return;
    }
    this.logger.log({
      event: 'retention_scheduler_started',
      tickIntervalMs: this.configuration.run.tickIntervalMs,
      runBudgetMs: this.configuration.run.runBudgetMs,
      batchSize: this.configuration.run.batchSize,
      timeZone: this.configuration.windows.timeZone,
    });
    this.loop.start();
  }

  /**
   * Stops asking for more work, then waits for the batch in flight.
   *
   * The flag is set before the loop is stopped, so a cycle already running sees it at
   * its next task or batch boundary and hands its window back rather than being
   * abandoned mid-run. `loop.stop()` then awaits that cycle - which is bounded by one
   * batch, not by the run's whole budget, which is what keeps the worker's drain
   * reasonable.
   */
  async onApplicationShutdown(): Promise<void> {
    if (!this.configuration.enabled) return;
    this.stopping = true;
    await this.loop.stop();
    this.logger.log({ event: 'retention_scheduler_stopped', drained: true });
  }

  private async tick(): Promise<void> {
    try {
      const outcomes = await this.runs.runAll(undefined, () => this.stopping);

      // A window that burned its attempts is refused `exhausted` on every tick from then
      // on, and will not run again until somebody acts. Filtering all refusals out - as
      // an earlier version did - made a permanently dead task indistinguishable from a
      // healthy one that found the day already done, in the logs of the thing that is
      // actually running. The operator command exits non-zero on this for the same
      // reason; the scheduler said nothing at all.
      const exhausted = outcomes.filter((one) => one.reason === 'exhausted');
      if (exhausted.length > 0) {
        this.logger.warn({
          event: 'retention_tasks_exhausted',
          tasks: exhausted.map((one) => one.taskName),
        });
      }

      // Otherwise only worth a line when something happened: a tick that found the day
      // already done is the common case and says nothing an operator needs.
      const acted = outcomes.filter((one) => one.outcome !== 'refused');
      if (acted.length > 0) {
        this.logger.log({
          event: 'retention_tick_completed',
          tasks: acted.map((one) => ({
            taskName: one.taskName,
            outcome: one.outcome,
            batches: one.batches,
            counts: one.counts,
          })),
        });
      }
    } catch (error) {
      // The loop must survive its own cycle. `runAll` already guards each task, so
      // reaching here means the clock read or the connection failed - transient by
      // nature, and the next tick is a minute away.
      this.logger.error({
        event: 'retention_tick_failed',
        reason: error instanceof Error ? error.name : 'UNKNOWN',
      });
    }
  }
}
