import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { retentionConfig } from '../config/retention.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { OutboxPollLoop } from '../common/outbox/outbox-poll-loop';
import { RetentionReportService } from './retention-report.service';
import { ScheduledRunRepository } from './scheduled-run.repository';
import type { RetentionBacklogTask } from './retention.types';

/**
 * The reading an operator watches when nobody is looking at the ledger.
 *
 * Four numbers per sample, and the pairs matter more than any single one. How much is
 * waiting and how long the oldest of it has been *overdue* separate a busy night from a
 * task that stopped running - a large backlog barely overdue is the first, a small one
 * days overdue is the second, and either alone is ambiguous. Beside them, how many
 * windows are recorded `FAILED` and how many are claimed past their lease: the first
 * says retention has given up on something and needs a person, the second says a process
 * died and recovery has not happened yet.
 *
 * It samples on its own timer rather than at the end of a run, because the readings that
 * matter most are the ones a stopped scheduler produces - and a sample that only happens
 * when a run finishes says nothing precisely when nothing is finishing.
 *
 * For the same reason it samples while the scheduler is **disabled**. That is the
 * configuration the rollout establishes and the one the runbook sends an operator to
 * inspect: deploy with retention off, read what is waiting, then turn it on. A sampler
 * that went quiet there would leave an operator unable to tell a backlog nobody is
 * draining from a worker that is not running at all.
 */
@Injectable()
export class RetentionBacklogService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RetentionBacklogService.name);
  private readonly loop = new OutboxPollLoop(
    () => this.sample(),
    () => this.configuration.run.backlogSampleIntervalMs,
  );

  constructor(
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly reports: RetentionReportService,
    private readonly runs: ScheduledRunRepository,
    @Inject(retentionConfig.KEY)
    private readonly configuration: ConfigType<typeof retentionConfig>,
  ) {}

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  async sample(): Promise<void> {
    try {
      // The operator command's reading, not a second copy of it. Two loops over the same
      // predicates would have to be kept in step - a new task, a changed argument, a
      // revised decision about running them serially - or the command and the worker
      // would disagree about what is due.
      const tasks: RetentionBacklogTask[] = (await this.reports.report()).map(
        (report) => ({
          taskName: report.taskName,
          table: report.table,
          windowHours: report.windowHours,
          due: report.dueCount,
          oldestOverdueMs: report.oldestOverdueMs,
        }),
      );

      const dataSource = await this.databaseConnection.ensureInitialized();
      const ledger = await this.runs.health(
        dataSource,
        this.configuration.run.recentFailureWindowDays,
      );
      this.logger.log({
        event: 'retention_backlog_sampled',
        tasks,
        // A window nobody will pick up again, and a window whose process died. Neither
        // is visible in the due counts: retention can be stopped dead with nothing
        // waiting yet, and this is where that shows first.
        failedWindows: ledger.failedWindows,
        staleClaims: ledger.staleClaims,
        oldestFailedAgeMs: ledger.oldestFailedAgeMs,
      });
    } catch (error) {
      // A sample that cannot be taken must not stop the loop that takes the next one.
      this.logger.warn({
        event: 'retention_backlog_failed',
        reason: error instanceof Error ? error.name : 'UNKNOWN',
      });
    }
  }
}
