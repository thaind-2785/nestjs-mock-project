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
import { retentionDuePredicates } from './retention-due';
import { RetentionDueRepository } from './retention-due.repository';
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
    private readonly due: RetentionDueRepository,
    private readonly runs: ScheduledRunRepository,
    @Inject(retentionConfig.KEY)
    private readonly configuration: ConfigType<typeof retentionConfig>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.configuration.enabled) return;
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.configuration.enabled) return;
    await this.loop.stop();
  }

  async sample(): Promise<void> {
    try {
      const dataSource = await this.databaseConnection.ensureInitialized();
      const tasks: RetentionBacklogTask[] = [];
      for (const predicate of retentionDuePredicates) {
        // Serially: five concurrent index scans against tables the API is serving is a
        // burst nobody asked for, and nothing here is slow enough to be worth
        // overlapping.
        const reading = await this.due.sample(
          dataSource.manager,
          predicate,
          this.configuration.windows,
          this.configuration.run.statementTimeoutMs,
        );
        tasks.push({
          taskName: predicate.taskName,
          table: predicate.table,
          windowHours: predicate.windowHours(this.configuration.windows),
          due: reading.dueCount,
          oldestOverdueMs: reading.oldestOverdueMs,
        });
      }

      const ledger = await this.runs.health(dataSource);
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
