import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';
import { roomExportResultTtlHours } from './reports.config';
import { maxBatchSize } from '../retention/retention.constants';

/*
 * The bounds below are code, not configuration, for the reason `reports.config.ts`
 * gives: none of them differs between staging and production, none is tuned during an
 * incident, and changing one is a decision that wants a reviewer rather than an
 * environment edit. Phase 6 cut the export surface from twenty-two variables to four
 * on exactly this argument, and this phase adds none.
 *
 * One value is read from the environment: the hotel timezone, because `CRON-01` is
 * specified daily in it and it is already validated there. Everything else is either a
 * constant below or, for idempotency keys, already written into the row itself.
 */

/**
 * How often the worker asks whether a window is due.
 *
 * A minute, because the question is one indexed lookup against a table with one row
 * per task per day. It is not how often retention runs - the ledger decides that - and
 * a shorter tick would only ask the same question more often.
 */
const tickIntervalMs = 60_000;

/**
 * The shortest a calendar day can be anywhere. A window is a local date rather than a
 * fixed 24 hours, so DST makes some days 23 hours long; the tick has to be shorter
 * than the shortest window or a day could open and close unseen.
 */
const minimumWindowMs = 23 * 60 * 60 * 1_000;

/** Rows per statement. Bounded so one pass cannot become a table-long lock. */
const batchSize = 500;

/** Matches the export snapshot's bound; a retention statement is no more entitled to
 * run unboundedly than a read is. */
const statementTimeoutMs = 30_000;

/**
 * How long a run may keep starting batches.
 *
 * A run is bounded by a clock rather than by a statement count, because the count was
 * fiction the moment a task could loop: a chain of three steps run twenty times is sixty
 * statements, not three. This is the number the lease is actually sized against, and a
 * run that reaches it stops and finishes with what it has - the remainder is still due
 * tomorrow, and lagging is the direction that cannot cause harm.
 */
const runBudgetMs = 300_000;

/** Slack between the budget and the lease, so a run that is merely slow is not treated
 * as a run that died. */
const leaseSafetyMarginMs = 30_000;

/**
 * How long shutdown waits for retention.
 *
 * One batch, not one run. A run may keep going for its whole budget, and waiting for
 * that on every deploy would make the worker's drain five minutes per task; instead the
 * run is interruptible - it stops after the batch in flight and hands the window back,
 * which is the same path a budget-truncated run already takes. So this only has to cover
 * the slowest single batch: one bounded claim read plus one bounded provider call.
 */
const shutdownDrainMs = 90_000;

/**
 * How often the backlog reading is written.
 *
 * A minute, matching the tick: the readings worth having are the ones a stopped
 * scheduler produces, so sampling on the run's schedule would go quiet exactly when
 * something is wrong.
 */
const backlogSampleIntervalMs = 60_000;

/**
 * How far back the failed-window reading looks.
 *
 * It needs a horizon because nothing ever rewrites a `FAILED` row: an unscoped count
 * latches and fires forever, including long after the cause is fixed, which is how an
 * alert stops being read. A week is long enough that a failure cannot be missed over a
 * weekend and short enough that a fixed one stops shouting.
 */
const recentFailureWindowDays = 7;

/**
 * How long a claimed run stays the claimer's before another replica may take it over.
 *
 * Generous against the worst case above rather than tight against the common one: the
 * cost of a lease that is too long is that a genuinely dead run waits; the cost of one
 * that is too short is two replicas deleting from the same tables at once.
 */
const claimLeaseMs = 600_000;

/** A failed run is retried within the same window, then recorded `FAILED` and left for
 * an operator. Unbounded retries would turn one broken predicate into a loop. */
const maxAttempts = 3;

/** Processed notification events are the evidence for "did the guest get the email",
 * and a complaint about a booking confirmation arrives in weeks, not months. */
const notificationEventRetentionDays = 30;

/**
 * How long a terminal export job's row survives after it stopped changing.
 *
 * The result lives 24 hours, and the metadata is kept a week past that, so a requester
 * who polls late is told the export `EXPIRED` rather than that it never existed. It is
 * anchored on `updated_at` rather than on `expires_at` because a failed job has no
 * expiry at all, and because `idx_export_jobs_operations` leads on `(status,
 * updated_at)` - an anchor the existing index cannot serve would turn the daily count
 * into a scan of every export ever run.
 */
const exportTerminalRetentionHours = roomExportResultTtlHours + 7 * 24;

/** An expired session grants nothing, so the only reason to hold one is to answer
 * "why was I logged out" for a day. */
const sessionRetentionHours = 24;

const hoursPerDay = 24;

/**
 * Idempotency keys have no window here on purpose.
 *
 * `idempotency_keys.expires_at` is written as "created plus
 * `IDEMPOTENCY_RETENTION_HOURS`" by the row's own author, so the promise `SPEC-006`
 * made is already in the row. Retention reads that column and nothing else; a second
 * copy of the window in this file would be a number nobody reads, which looks exactly
 * like a number that works.
 */

export interface RetentionRunConfiguration {
  tickIntervalMs: number;
  shutdownDrainMs: number;
  backlogSampleIntervalMs: number;
  recentFailureWindowDays: number;
  batchSize: number;
  statementTimeoutMs: number;
  runBudgetMs: number;
  claimLeaseMs: number;
  maxAttempts: number;
}

export interface RetentionWindowConfiguration {
  /** Where a day begins. A window is a local calendar date, not a fixed interval. */
  timeZone: string;
  notificationEventHours: number;
  exportTerminalHours: number;
  sessionHours: number;
}

export interface RetentionConfiguration {
  /**
   * Read in the worker, where it gates the scheduler. The operator command ignores it:
   * running retention by hand is what the rollout does before this is ever turned on.
   */
  enabled: boolean;
  run: RetentionRunConfiguration;
  windows: RetentionWindowConfiguration;
}

export function createRetentionConfiguration(
  environment: EnvironmentVariables,
): RetentionConfiguration {
  const configuration: RetentionConfiguration = {
    enabled: environment.RETENTION_ENABLED,
    run: {
      tickIntervalMs,
      shutdownDrainMs,
      backlogSampleIntervalMs,
      recentFailureWindowDays,
      batchSize,
      statementTimeoutMs,
      runBudgetMs,
      claimLeaseMs,
      maxAttempts,
    },
    windows: {
      timeZone: environment.HOTEL_TIMEZONE,
      notificationEventHours: notificationEventRetentionDays * hoursPerDay,
      exportTerminalHours: exportTerminalRetentionHours,
      sessionHours: sessionRetentionHours,
    },
  };
  assertRetentionBounds(configuration);
  return configuration;
}

/**
 * Refuses a configuration whose numbers contradict each other, at startup rather than
 * at the first run that deletes something.
 *
 * Every check here is a relationship between two values. A check on a single value in
 * isolation belongs in the environment schema, and a check that cannot fail belongs
 * nowhere at all - a guard that no configuration can trip reads exactly like a guard
 * that works.
 */
export function assertRetentionBounds(
  configuration: RetentionConfiguration,
): void {
  const { run } = configuration;
  const unbounded: string[] = [];

  // A tick slower than the shortest window could let a day open and close unobserved,
  // and the run for it would never be claimed by anybody.
  if (run.tickIntervalMs > minimumWindowMs) {
    unbounded.push('run.tickIntervalMs');
  }
  // A batch past the measured ceiling is a statement whose duration nobody has
  // established, holding locks on tables the API is also using.
  if (run.batchSize > maxBatchSize || run.batchSize < 1) {
    unbounded.push('run.batchSize');
  }
  // The lease must outlive the slowest legal run: the whole budget, plus the one
  // statement that may still be in flight when the budget runs out, plus slack. Shorter,
  // and a second replica takes over a run that was still working, so two processes
  // delete from the same tables at once - the one thing the singleton exists to prevent.
  if (
    run.claimLeaseMs <
    run.runBudgetMs + run.statementTimeoutMs + leaseSafetyMarginMs
  ) {
    unbounded.push('run.claimLeaseMs');
  }
  // A budget shorter than one statement's own bound could not finish a single batch,
  // so every run would stop having done nothing and the backlog would only grow.
  if (run.runBudgetMs < run.statementTimeoutMs) {
    unbounded.push('run.runBudgetMs');
  }
  // The drain has to cover the slowest batch, not the slowest statement. A batch is a
  // bounded claim read followed by at most one provider call before the stop flag is
  // consulted again, so two statement budgets plus slack is the bound that is actually
  // true - checking it against one was the arithmetic that let a batch outlive the drain.
  if (run.shutdownDrainMs < run.statementTimeoutMs * 2 + leaseSafetyMarginMs) {
    unbounded.push('run.shutdownDrainMs');
  }
  // Zero attempts is a task that can never run; it would look like a task with nothing
  // due rather than like a misconfiguration.
  if (run.maxAttempts < 1) {
    unbounded.push('run.maxAttempts');
  }
  // Deleting an export's row while its object is still downloadable would leave a
  // presigned URL working against a result nothing can describe. The metadata has to
  // outlive the result, not merely accompany it.
  if (configuration.windows.exportTerminalHours <= roomExportResultTtlHours) {
    unbounded.push('windows.exportTerminalHours');
  }

  if (unbounded.length > 0) {
    throw new Error(
      `Retention bounds are inconsistent for: ${unbounded.sort().join(', ')}`,
    );
  }
}

export const retentionConfig = registerAs('retention', () =>
  createRetentionConfiguration(validateEnvironment(process.env)),
);
