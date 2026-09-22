import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

/*
 * The bounds below are code, not configuration, for the reason `reports.config.ts`
 * gives: none of them differs between staging and production, none is tuned during an
 * incident, and changing one is a decision that wants a reviewer rather than an
 * environment edit. Phase 6 cut the export surface from twenty-two variables to four
 * on exactly this argument, and this phase adds none.
 *
 * Two values are read from the environment rather than named here, because they were
 * already promised elsewhere: the hotel timezone, which decides where a day begins,
 * and the idempotency window, which `SPEC-006` promised as a minimum and Joi already
 * floors at 24 hours. Retention uses that value verbatim; a constant of its own could
 * silently undercut the promise.
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

/**
 * The ceiling `batchSize` is allowed to reach.
 *
 * It exists so the bound is checkable rather than asserted about itself: a thousand
 * rows is what a single indexed delete finishes well inside `statementTimeoutMs` on
 * the shapes this schema produces, and raising it is a decision that wants the
 * measurement redone.
 */
const maxBatchSize = 1_000;

/** Matches the export snapshot's bound; a retention statement is no more entitled to
 * run unboundedly than a read is. */
const statementTimeoutMs = 30_000;

/**
 * The most statements one run can serialise: three single-table purges, and two chains
 * of three steps each. The lease has to cover all of them at their worst case, because
 * this phase does not renew mid-run.
 */
const worstCaseStatementsPerRun = 9;

/** Slack between the worst case and the lease, so a run that is merely slow is not
 * treated as a run that died. */
const leaseSafetyMarginMs = 30_000;

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

/** Results live 24 hours. Keeping the metadata a week past that means a requester who
 * polls late is told the export `EXPIRED`, not that it never existed. */
const exportMetadataRetentionDays = 7;

/** An expired session grants nothing, so the only reason to hold one is to answer
 * "why was I logged out" for a day. */
const sessionRetentionHours = 24;

const hoursPerDay = 24;

export interface RetentionRunConfiguration {
  tickIntervalMs: number;
  batchSize: number;
  statementTimeoutMs: number;
  claimLeaseMs: number;
  maxAttempts: number;
}

export interface RetentionWindowConfiguration {
  /** Where a day begins. A window is a local calendar date, not a fixed interval. */
  timeZone: string;
  notificationEventHours: number;
  exportMetadataHours: number;
  sessionHours: number;
  /** From the environment, floored at 24 hours by `SPEC-006`'s promise. */
  idempotencyHours: number;
}

export interface RetentionConfiguration {
  run: RetentionRunConfiguration;
  windows: RetentionWindowConfiguration;
}

export function createRetentionConfiguration(
  environment: EnvironmentVariables,
): RetentionConfiguration {
  const configuration: RetentionConfiguration = {
    run: {
      tickIntervalMs,
      batchSize,
      statementTimeoutMs,
      claimLeaseMs,
      maxAttempts,
    },
    windows: {
      timeZone: environment.HOTEL_TIMEZONE,
      notificationEventHours: notificationEventRetentionDays * hoursPerDay,
      exportMetadataHours: exportMetadataRetentionDays * hoursPerDay,
      sessionHours: sessionRetentionHours,
      idempotencyHours: environment.IDEMPOTENCY_RETENTION_HOURS,
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
 * nowhere: `windows.idempotencyHours` is deliberately unguarded here because it is the
 * environment's value used verbatim, and asserting that a value equals itself reads
 * exactly like a guard that works.
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
  // The lease must outlive the slowest legal run. Shorter, and a second replica takes
  // over a run that was still working, so two processes delete from the same tables at
  // once - which is the one thing the singleton exists to prevent.
  if (
    run.claimLeaseMs <
    run.statementTimeoutMs * worstCaseStatementsPerRun + leaseSafetyMarginMs
  ) {
    unbounded.push('run.claimLeaseMs');
  }
  // Zero attempts is a task that can never run; it would look like a task with nothing
  // due rather than like a misconfiguration.
  if (run.maxAttempts < 1) {
    unbounded.push('run.maxAttempts');
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
