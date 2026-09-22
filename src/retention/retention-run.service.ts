import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
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

  /**
   * Every task, in the order that puts the ones with no dependents first.
   *
   * `shouldStop` is how shutdown gets out without abandoning anything. Asked between
   * tasks and between batches, never mid-statement, so the worst a drain waits for is
   * one batch - and whatever was left is handed back as incomplete rather than recorded
   * as done. Waiting for a whole run instead would make the worker's drain five minutes
   * per task on every deploy.
   */
  async runAll(
    batchSize?: number,
    shouldStop?: () => boolean,
  ): Promise<RetentionRunOutcome[]> {
    const dataSource = await this.databaseConnection.ensureInitialized();
    // Resolved once for the whole run. Resolving it per task meant a run that started at
    // 23:58 and spent two minutes on the first task claimed day D for the first two and
    // day D+1 for the last three - so day D was never claimed for them, and the next
    // day's tick found D+1 already succeeded. A whole day skipped, with the ledger
    // reporting success.
    const scheduledFor = await this.currentWindow(dataSource);

    const outcomes: RetentionRunOutcome[] = [];
    for (const taskName of retentionTaskNames) {
      if (shouldStop?.()) break;
      try {
        // Serially, and one task's failure must not stop the rest: a full bucket must
        // not prevent three empty ones from draining. The guard is here rather than
        // inside `runTask` because the parts before its own `try` - the clock read and
        // the claim - can throw too, and an unguarded push would take the loop with it.
        outcomes.push(
          await this.runTask(taskName, batchSize, scheduledFor, shouldStop),
        );
      } catch (error) {
        const errorCode = classify(error);
        this.logger.error({
          event: 'retention_run_failed',
          taskName,
          scheduledFor: scheduledFor.toISOString(),
          errorCode,
          reason: error instanceof Error ? error.name : 'UNKNOWN',
        });
        outcomes.push({
          taskName,
          outcome: 'failed',
          counts: {},
          batches: 0,
          budgetSpent: false,
          errorCode,
        });
      }
    }
    return outcomes;
  }

  async runTask(
    taskName: RetentionTaskName,
    batchSize?: number,
    window?: Date,
    shouldStop?: () => boolean,
  ): Promise<RetentionRunOutcome> {
    const dataSource = await this.databaseConnection.ensureInitialized();
    const { run } = this.configuration;
    const size = batchSize ?? run.batchSize;
    const scheduledFor = window ?? (await this.currentWindow(dataSource));

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
    let interrupted = false;
    let retryableFailures = 0;
    // The process clock, and the only place in this phase where one decides anything.
    // It is measuring elapsed work rather than naming an instant, so there is no second
    // opinion about what time it is - only about how long this has been going.
    const deadline = Date.now() + run.runBudgetMs;

    try {
      for (;;) {
        const outcome = await this.tasks.runBatch(
          dataSource,
          taskName,
          size,
          deadline,
        );
        batches += 1;
        retryableFailures += outcome.retryableFailures ?? 0;
        for (const [table, removed] of Object.entries(outcome.counts)) {
          counts[table] = (counts[table] ?? 0) + removed;
        }
        if (!outcome.moreWaiting) break;
        if (shouldStop?.()) {
          interrupted = true;
          break;
        }
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
      // Best-effort: this writes to the database that just failed, and an exception here
      // would replace the original one - so the cause would never reach the log below
      // and the counts for rows already deleted would go with it.
      try {
        await this.runs.fail(
          dataSource,
          claim.claim,
          { errorCode, retryable: true },
          counts,
          run.maxAttempts,
        );
      } catch (recordingError) {
        this.logger.error({
          event: 'retention_run_record_failed',
          taskName,
          errorCode: retentionErrorCodes.taskFailed,
          reason:
            recordingError instanceof Error ? recordingError.name : 'UNKNOWN',
        });
      }
      this.logger.error({
        event: 'retention_run_failed',
        taskName,
        scheduledFor: scheduledFor.toISOString(),
        attempt: claim.claim.attempt,
        errorCode,
        // The class name, not the message: a type rather than content, so no SQL and no
        // provider text. Without it `RETENTION_TASK_FAILED` - which means "we do not
        // know" - was the entire record of the failure.
        reason: error instanceof Error ? error.name : 'UNKNOWN',
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

    // A run that stopped short did not succeed, and saying so durably is the whole
    // point. `complete` would clear the lease and the unique key would then refuse every
    // further claim that day - so "the remainder is still due tomorrow" would be false
    // for anything larger than one budget, and the ledger would report SUCCEEDED every
    // night while the backlog grew. Handing the window back instead reuses the retry
    // path: the next run continues it, and the attempt budget still bounds the day.
    const incomplete = budgetSpent || interrupted || retryableFailures > 0;
    if (incomplete) {
      const errorCode = interrupted
        ? retentionErrorCodes.shutdown
        : budgetSpent
          ? retentionErrorCodes.budgetSpent
          : retentionErrorCodes.storageIncomplete;
      const handedBack = await this.runs.fail(
        dataSource,
        claim.claim,
        { errorCode, retryable: true },
        counts,
        run.maxAttempts,
      );
      this.logger.warn({
        event: 'retention_run_incomplete',
        taskName,
        scheduledFor: scheduledFor.toISOString(),
        attempt: claim.claim.attempt,
        batches,
        budgetSpent,
        interrupted,
        retryableFailures,
        errorCode,
        recorded: handedBack,
        counts,
      });
      return {
        taskName,
        outcome: 'incomplete',
        counts,
        batches,
        budgetSpent,
        retryableFailures,
        errorCode: handedBack ? errorCode : retentionErrorCodes.claimLost,
      };
    }

    const recorded = await this.runs.complete(dataSource, claim.claim, counts);
    this.logger.log({
      event: 'retention_run_completed',
      taskName,
      scheduledFor: scheduledFor.toISOString(),
      attempt: claim.claim.attempt,
      batches,
      recorded,
      counts,
    });
    return {
      taskName,
      outcome: recorded ? 'completed' : 'failed',
      counts,
      batches,
      budgetSpent,
      retryableFailures,
      errorCode: recorded ? undefined : retentionErrorCodes.claimLost,
    };
  }

  /** The window every task in one run must agree on, from the database clock. */
  private async currentWindow(dataSource: DataSource): Promise<Date> {
    const rows: Array<{ now: Date }> = await dataSource.query(
      'SELECT NOW(6) AS now',
    );
    return localDayStart(
      new Date(rows[0].now),
      this.configuration.windows.timeZone,
    );
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
