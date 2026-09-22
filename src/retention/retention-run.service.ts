import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { retentionConfig } from '../config/retention.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { localDayStart } from './retention-window';
import { RetentionTasksService } from './retention-tasks.service';
import {
  retentionErrorCodes,
  retentionTaskNames,
  type RetentionErrorCode,
  type RetentionTaskName,
} from './retention.constants';
import { ScheduledRunRepository } from './scheduled-run.repository';
import type { RetentionRunOutcome } from './retention.types';

/**
 * One window of one task, from the election to the ledger row that records it.
 *
 * The run owns three things the tasks deliberately do not: which window it is working
 * on, when to stop, and what to write down. A task knows how to delete a batch and
 * whether more is waiting; it has no opinion about budgets or ledgers.
 *
 * Stopping is a clock, not a count. A run keeps starting batches until nothing is
 * waiting or its budget is spent, then finishes with whatever it has. The remainder is
 * still due tomorrow, and retention that lags is the only failure mode this phase is
 * willing to have.
 */
@Injectable()
export class RetentionRunService {
  private readonly logger = new Logger(RetentionRunService.name);

  constructor(
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly runs: ScheduledRunRepository,
    private readonly tasks: RetentionTasksService,
    @Inject(retentionConfig.KEY)
    private readonly configuration: ConfigType<typeof retentionConfig>,
  ) {}

  /** Every task, in the order that puts the ones with no dependents first. */
  async runAll(batchSize?: number): Promise<RetentionRunOutcome[]> {
    const outcomes: RetentionRunOutcome[] = [];
    for (const taskName of retentionTaskNames) {
      // Serially, and without letting one task's failure stop the rest: a full bucket
      // must not prevent three empty ones from draining, and the five windows are
      // independent by construction.
      outcomes.push(await this.runTask(taskName, batchSize));
    }
    return outcomes;
  }

  async runTask(
    taskName: RetentionTaskName,
    batchSize?: number,
  ): Promise<RetentionRunOutcome> {
    const dataSource = await this.databaseConnection.ensureInitialized();
    const { run, windows } = this.configuration;
    const size = batchSize ?? run.batchSize;

    const rows: Array<{ now: Date }> = await dataSource.query(
      'SELECT NOW(6) AS now',
    );
    const scheduledFor = localDayStart(new Date(rows[0].now), windows.timeZone);

    const claim = await this.runs.claim(dataSource, {
      taskName,
      scheduledFor,
      leaseMs: run.claimLeaseMs,
      maxAttempts: run.maxAttempts,
    });
    if (claim.outcome === 'refused') {
      return {
        taskName,
        outcome: 'refused',
        reason: claim.reason,
        counts: {},
        batches: 0,
        budgetSpent: false,
      };
    }

    this.logger.log({
      event: 'retention_run_started',
      taskName,
      scheduledFor: scheduledFor.toISOString(),
      attempt: claim.claim.attempt,
      batchSize: size,
    });

    const counts: Record<string, number> = {};
    let batches = 0;
    let budgetSpent = false;
    // The process clock, and the only place in this phase where one decides anything.
    // It is measuring elapsed work rather than naming an instant, so there is no second
    // opinion about what time it is - only about how long this has been going.
    const deadline = Date.now() + run.runBudgetMs;

    try {
      for (;;) {
        const outcome = await this.tasks.runBatch(dataSource, taskName, size);
        batches += 1;
        for (const [table, removed] of Object.entries(outcome.counts)) {
          counts[table] = (counts[table] ?? 0) + removed;
        }
        if (!outcome.moreWaiting) break;
        if (Date.now() >= deadline) {
          budgetSpent = true;
          break;
        }
      }
    } catch (error) {
      // Unclassified means "we do not know", which is a statement about this code rather
      // than about the database, so it is retryable and the attempt budget bounds the
      // cost of being wrong.
      const errorCode = classify(error);
      await this.runs.fail(
        dataSource,
        claim.claim,
        { errorCode, retryable: true },
        counts,
        run.maxAttempts,
      );
      this.logger.error({
        event: 'retention_run_failed',
        taskName,
        scheduledFor: scheduledFor.toISOString(),
        attempt: claim.claim.attempt,
        errorCode,
        counts,
      });
      return {
        taskName,
        outcome: 'failed',
        counts,
        batches,
        budgetSpent,
        errorCode,
      };
    }

    const recorded = await this.runs.complete(dataSource, claim.claim, counts);
    this.logger.log({
      event: 'retention_run_completed',
      taskName,
      scheduledFor: scheduledFor.toISOString(),
      attempt: claim.claim.attempt,
      batches,
      budgetSpent,
      recorded,
      counts,
    });
    return {
      taskName,
      outcome: recorded ? 'completed' : 'failed',
      counts,
      batches,
      budgetSpent,
      errorCode: recorded ? undefined : retentionErrorCodes.claimLost,
    };
  }
}

/** MySQL's statement-timeout error, the one failure this phase can name. */
const statementTimeoutErrno = 3024;

function classify(error: unknown): RetentionErrorCode {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { errno?: number }).errno
      : undefined;
  return code === statementTimeoutErrno
    ? retentionErrorCodes.statementTimeout
    : retentionErrorCodes.taskFailed;
}
