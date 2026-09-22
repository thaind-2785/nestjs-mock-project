import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  microsecondsPerMillisecond,
  retentionContinuationCodes,
  retentionErrorCodes,
  type RetentionTaskName,
} from './retention.constants';
import { ScheduledRunStatus } from './entities/scheduled-run.enums';
import type {
  ScheduledRunClaimResult,
  ScheduledRunFailure,
} from './scheduled-run.types';

/** MySQL's duplicate-key error: the winner had already committed this window. */
const duplicateEntryErrno = 1062;

/**
 * MySQL's lock-wait timeout, which a losing insert gets instead of a duplicate key
 * when the winner has not committed yet.
 *
 * Reading it as a lost election is narrow and deliberate. This statement inserts one
 * row with one unique key, so the only lock it can ever wait on is that window's, and
 * waiting on it means somebody else is inserting it. The same code anywhere else would
 * be wrong.
 */
const lockWaitTimeoutErrno = 1205;

function errno(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { errno?: number }).errno
    : undefined;
}

/**
 * Builds the accumulate-in-place expression for `deleted_counts`.
 *
 * Adds to whatever is already there instead of replacing it, because the counts belong
 * to the window rather than to the attempt: a run that removed three hundred rows and
 * then timed out removed three hundred rows, and the attempt that finishes must not
 * report only its own fifty.
 *
 * The table names are interpolated because a JSON path cannot be a bound parameter.
 * They are not data - every one is a key the caller built from `retentionDuePredicates`
 * - and the counts themselves stay bound.
 */
function accumulateCounts(counts: Record<string, number>): {
  expression: string;
  parameters: number[];
} {
  const tables = Object.keys(counts).sort();
  if (tables.length === 0) {
    return { expression: 'deleted_counts', parameters: [] };
  }
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) {
      throw new Error(`Unusable deleted_counts key: ${table}`);
    }
  }
  // `CAST(... AS SIGNED)` because MySQL's JSON arithmetic yields a DOUBLE, so the sum
  // would be stored as `1.0`. A row count is a whole number, and the ledger is what an
  // operator reads to find out how much was deleted.
  const pairs = tables
    .map(
      (table) =>
        `'$.${table}', CAST(COALESCE(JSON_EXTRACT(deleted_counts, '$.${table}'), 0) + ? AS SIGNED)`,
    )
    .join(', ');
  return {
    expression: `JSON_SET(COALESCE(deleted_counts, JSON_OBJECT()), ${pairs})`,
    parameters: tables.map((table) => counts[table]),
  };
}

/**
 * Every write a scheduled run makes to its own ledger row.
 *
 * Two rules run through all of it.
 *
 * The first is that the claim is an insert: a window is won by being the replica whose
 * `INSERT` the unique key accepted, not by holding a lock.
 *
 * The second is that **none of these writes may share the caller's transaction**. The
 * ledger is coordination state, not business data, and entangling it with the deletions
 * it accounts for breaks the first rule: while the winner's transaction is open its
 * unique-key lock is uncommitted, so a losing replica's insert does not get a duplicate
 * key at all - it blocks, and fails with a lock-wait timeout after
 * `innodb_lock_wait_timeout`. Losing an election would become a crash for every replica
 * but one. That is measured rather than reasoned: two transactions inserting the same
 * key give the second `ERROR 1205`, not `1062`.
 *
 * So each method takes the `DataSource` and runs on its own. The deletions commit per
 * batch anyway, which is what lets a run be interrupted without being rolled back.
 *
 * The claim token carries the predicate on every later write. It is a fresh UUID per
 * claim, so a recovery replaces it and the previous holder's writes stop matching.
 */
@Injectable()
export class ScheduledRunRepository {
  private readonly logger = new Logger(ScheduledRunRepository.name);

  /**
   * Wins, recovers, or loses one window.
   *
   * The insert is tried first because it is the common case and needs no read: on an
   * untouched window exactly one replica succeeds and the rest learn they lost from the
   * database rather than from a race they had to observe. Only after losing does this
   * look at why.
   */
  async claim(
    dataSource: DataSource,
    input: {
      taskName: RetentionTaskName;
      scheduledFor: Date;
      leaseMs: number;
      maxAttempts: number;
    },
  ): Promise<ScheduledRunClaimResult> {
    const manager = dataSource.manager;
    const id = randomUUID();
    const claimToken = randomUUID();
    try {
      await manager.query(
        `INSERT INTO scheduled_runs
           (id, task_name, scheduled_for, status, locked_by, lock_expires_at,
            attempts, started_at)
         VALUES (?, ?, ?, ?, ?, NOW(6) + INTERVAL ? MICROSECOND, 1, NOW(6))`,
        [
          id,
          input.taskName,
          input.scheduledFor,
          ScheduledRunStatus.Claimed,
          claimToken,
          input.leaseMs * microsecondsPerMillisecond,
        ],
      );
      return {
        outcome: 'claimed',
        claim: {
          id,
          taskName: input.taskName,
          scheduledFor: input.scheduledFor,
          claimToken,
          attempt: 1,
        },
      };
    } catch (error) {
      const code = errno(error);
      if (code === lockWaitTimeoutErrno) {
        // Somebody is inserting this window right now and has not committed. There is
        // nothing to recover and nothing even to read: every statement touching the row
        // would block on the same uncommitted lock and time out in turn - which is how
        // the first version of this handler failed, catching 1205 on the insert and
        // then raising it again from the recovery update. A window somebody is actively
        // claiming is simply taken.
        return { outcome: 'refused', reason: 'taken' };
      }
      // A duplicate key means the winner committed, so the row is readable and may well
      // be an old one whose attempt died - which is what recovery is for.
      if (code !== duplicateEntryErrno) throw error;
    }
    return this.recover(manager, { ...input, claimToken });
  }

  /**
   * Takes over a window whose previous attempt died, or says why it cannot.
   *
   * `lock_expires_at <= NOW(6)` is part of the predicate rather than a check afterwards:
   * a lease that is still live belongs to whoever holds it, and finding that out after
   * starting to delete would be too late. `attempts < ?` is what stops a task that
   * crashes every time from being retried on every tick forever.
   *
   * The increment is conditional, and that distinction is load-bearing. `attempts`
   * counts failures; a window handed back because its budget ran out, a deploy
   * interrupted it, or a provider was refusing is *continuing*, and charging it would
   * mean a genuinely large backlog gave up after three continuations - roughly fifteen
   * minutes of honest work - and needed a human. Three deploys during a nightly run did
   * the same. A continuation that deleted nothing is charged anyway, because a window
   * making no progress is not continuing.
   */
  private async recover(
    manager: EntityManager,
    input: {
      taskName: RetentionTaskName;
      scheduledFor: Date;
      leaseMs: number;
      maxAttempts: number;
      claimToken: string;
    },
  ): Promise<ScheduledRunClaimResult> {
    const taken: { affectedRows?: number } = await manager.query(
      `UPDATE scheduled_runs
       SET locked_by = ?,
           lock_expires_at = NOW(6) + INTERVAL ? MICROSECOND,
           attempts = attempts + IF(
             last_error_code IN (${retentionContinuationCodes.map(() => '?').join(', ')})
               AND JSON_LENGTH(COALESCE(deleted_counts, JSON_OBJECT())) > 0,
             0,
             1
           ),
           started_at = NOW(6)
       WHERE task_name = ?
         AND scheduled_for = ?
         AND status = ?
         AND lock_expires_at <= NOW(6)
         AND attempts < ?`,
      [
        input.claimToken,
        input.leaseMs * microsecondsPerMillisecond,
        ...retentionContinuationCodes,
        input.taskName,
        input.scheduledFor,
        ScheduledRunStatus.Claimed,
        input.maxAttempts,
      ],
    );
    if ((taken.affectedRows ?? 0) > 0) {
      // Read back rather than computed: the attempt number is whatever the database
      // incremented it to, and the row already existed with a history this replica
      // never saw.
      const rows: Array<{ id: string; attempts: number }> = await manager.query(
        'SELECT id, attempts FROM scheduled_runs WHERE locked_by = ?',
        [input.claimToken],
      );
      if (rows.length === 0) return { outcome: 'refused', reason: 'taken' };
      return {
        outcome: 'claimed',
        claim: {
          id: rows[0].id,
          taskName: input.taskName,
          scheduledFor: input.scheduledFor,
          claimToken: input.claimToken,
          attempt: rows[0].attempts,
        },
      };
    }

    // The run died and its budget is spent. Somebody has to write that down, because
    // the process that died could not, and a claimed row nobody may recover would
    // otherwise sit in the recoverable index forever looking like work in progress.
    const abandoned: { affectedRows?: number } = await manager.query(
      `UPDATE scheduled_runs
       SET status = ?,
           locked_by = NULL,
           lock_expires_at = NULL,
           finished_at = NOW(6),
           last_error_code = ?
       WHERE task_name = ?
         AND scheduled_for = ?
         AND status = ?
         AND lock_expires_at <= NOW(6)
         AND attempts >= ?`,
      [
        ScheduledRunStatus.Failed,
        retentionErrorCodes.runAbandoned,
        input.taskName,
        input.scheduledFor,
        ScheduledRunStatus.Claimed,
        input.maxAttempts,
      ],
    );
    if ((abandoned.affectedRows ?? 0) > 0) {
      this.logger.error({
        event: 'retention_run_abandoned',
        taskName: input.taskName,
        scheduledFor: input.scheduledFor.toISOString(),
        errorCode: retentionErrorCodes.runAbandoned,
        attempts: input.maxAttempts,
      });
      return { outcome: 'refused', reason: 'exhausted' };
    }

    // Nothing was claimed and nothing was abandoned, so the window is either somebody
    // else's right now or already finished. Which one matters: a window recorded FAILED
    // is a task that will not run again until an operator acts, and reporting that as
    // an ordinary "taken" would announce it once and then describe a dead task as
    // healthy on every tick afterwards.
    return {
      outcome: 'refused',
      reason: await this.refusalReason(manager, input),
    };
  }

  private async refusalReason(
    manager: EntityManager,
    key: { taskName: RetentionTaskName; scheduledFor: Date },
  ): Promise<'taken' | 'exhausted'> {
    const rows: Array<{ status: ScheduledRunStatus }> = await manager.query(
      `SELECT status FROM scheduled_runs
       WHERE task_name = ? AND scheduled_for = ?`,
      [key.taskName, key.scheduledFor],
    );
    return rows[0]?.status === ScheduledRunStatus.Failed
      ? 'exhausted'
      : 'taken';
  }

  /**
   * Records a finished run and releases the window.
   *
   * `false` means the claim was gone - the lease expired while the run was working and
   * another replica took it over. Nothing at all is written then, counts included: one
   * rule, applied everywhere, beats an exception for the one write that looks harmless.
   * The rows really were deleted though, so that number leaves through the log instead,
   * which is the only place the ledger and reality can be reconciled afterwards.
   */
  async complete(
    dataSource: DataSource,
    claim: { claimToken: string; taskName: RetentionTaskName },
    deletedCounts: Record<string, number>,
  ): Promise<boolean> {
    const counts = accumulateCounts(deletedCounts);
    const result: { affectedRows?: number } = await dataSource.manager.query(
      `UPDATE scheduled_runs
       SET status = ?,
           locked_by = NULL,
           lock_expires_at = NULL,
           finished_at = NOW(6),
           deleted_counts = ${counts.expression}
       WHERE locked_by = ?
         AND status = ?
         AND lock_expires_at > NOW(6)`,
      [
        ScheduledRunStatus.Succeeded,
        ...counts.parameters,
        claim.claimToken,
        ScheduledRunStatus.Claimed,
      ],
    );
    const applied = (result.affectedRows ?? 0) > 0;
    if (!applied) this.warnClaimLost(claim, deletedCounts, 'complete');
    return applied;
  }

  /**
   * Records a failed run, and decides whether the window is handed back or closed.
   *
   * A retryable failure with budget left hands the window back by expiring its own
   * lease, which makes the retry path and the crash-recovery path the same mechanism
   * rather than two that have to agree. Anything else is terminal and loud.
   */
  async fail(
    dataSource: DataSource,
    claim: { claimToken: string; attempt: number; taskName: RetentionTaskName },
    failure: ScheduledRunFailure,
    deletedCounts: Record<string, number>,
    maxAttempts: number,
  ): Promise<boolean> {
    const handBack = failure.retryable && claim.attempt < maxAttempts;
    const counts = accumulateCounts(deletedCounts);
    const result: { affectedRows?: number } = await dataSource.manager.query(
      handBack
        ? `UPDATE scheduled_runs
           SET lock_expires_at = NOW(6),
               deleted_counts = ${counts.expression},
               last_error_code = ?
           WHERE locked_by = ?
             AND status = ?
             AND lock_expires_at > NOW(6)`
        : `UPDATE scheduled_runs
           SET status = ?,
               locked_by = NULL,
               lock_expires_at = NULL,
               finished_at = NOW(6),
               deleted_counts = ${counts.expression},
               last_error_code = ?
           WHERE locked_by = ?
             AND status = ?
             AND lock_expires_at > NOW(6)`,
      handBack
        ? [
            ...counts.parameters,
            failure.errorCode,
            claim.claimToken,
            ScheduledRunStatus.Claimed,
          ]
        : [
            ScheduledRunStatus.Failed,
            ...counts.parameters,
            failure.errorCode,
            claim.claimToken,
            ScheduledRunStatus.Claimed,
          ],
    );
    const applied = (result.affectedRows ?? 0) > 0;
    if (!applied) this.warnClaimLost(claim, deletedCounts, 'fail');
    return applied;
  }

  /**
   * What the ledger says about retention as a whole, rather than about one window.
   *
   * Both readings are narrower than they first were, and both for the same reason: a
   * number an operator is told to alert on has to be able to return to zero, and has to
   * count only what its name says.
   *
   * `failedWindows` is scoped to recent windows. Nothing ever rewrites a `FAILED` row,
   * so an unscoped count latches: it fires forever, including long after the cause is
   * fixed, which is how an alert stops being read.
   *
   * `staleClaims` excludes a window that was handed back on purpose. A continuation
   * expires its own lease and leaves the status alone, which is byte-identical to what a
   * dead process leaves - so counting the shape rather than the intent made every
   * ordinary budget-spent run look like a crash.
   */
  async health(
    dataSource: DataSource,
    recentWindowDays: number,
  ): Promise<{
    failedWindows: number;
    staleClaims: number;
    oldestFailedAgeMs: number;
  }> {
    const continuations = retentionContinuationCodes.map(() => '?').join(', ');
    const rows: Array<{
      failed_windows: number;
      stale_claims: number;
      oldest_failed_age_us: string | number;
    }> = await dataSource.manager.query(
      `SELECT
         SUM(status = ? AND scheduled_for >= NOW(6) - INTERVAL ? DAY)
           AS failed_windows,
         SUM(
           status = ?
           AND lock_expires_at <= NOW(6)
           AND (last_error_code IS NULL OR last_error_code NOT IN (${continuations}))
         ) AS stale_claims,
         COALESCE(
           TIMESTAMPDIFF(
             MICROSECOND,
             MIN(
               CASE
                 WHEN status = ? AND scheduled_for >= NOW(6) - INTERVAL ? DAY
                 THEN finished_at
               END
             ),
             NOW(6)
           ),
           0
         ) AS oldest_failed_age_us
       FROM scheduled_runs`,
      [
        ScheduledRunStatus.Failed,
        recentWindowDays,
        ScheduledRunStatus.Claimed,
        ...retentionContinuationCodes,
        ScheduledRunStatus.Failed,
        recentWindowDays,
      ],
    );
    return {
      failedWindows: Number(rows[0].failed_windows ?? 0),
      staleClaims: Number(rows[0].stale_claims ?? 0),
      oldestFailedAgeMs: Math.floor(
        Number(rows[0].oldest_failed_age_us) / microsecondsPerMillisecond,
      ),
    };
  }

  /**
   * Closes windows from earlier days that nobody will continue.
   *
   * A run only ever claims the current window, so a window handed back for continuation
   * and not reclaimed before the local day rolled over is touched by nothing again: it
   * stays `CLAIMED` forever, and the work it left is silently nobody's. Recording it
   * `FAILED` is the truthful version - that day's retention did not finish - and it is
   * also what lets the stale-claim reading stay a measure of the present.
   */
  async closeAbandonedBefore(
    dataSource: DataSource,
    currentWindow: Date,
  ): Promise<number> {
    const result: { affectedRows?: number } = await dataSource.manager.query(
      `UPDATE scheduled_runs
       SET status = ?,
           locked_by = NULL,
           lock_expires_at = NULL,
           finished_at = NOW(6),
           last_error_code = COALESCE(last_error_code, ?)
       WHERE status = ?
         AND scheduled_for < ?
         AND lock_expires_at <= NOW(6)`,
      [
        ScheduledRunStatus.Failed,
        retentionErrorCodes.runAbandoned,
        ScheduledRunStatus.Claimed,
        currentWindow,
      ],
    );
    return result.affectedRows ?? 0;
  }

  /**
   * A run finished work it is no longer entitled to record.
   *
   * Worth a line of its own: the rows it names really were deleted, and the ledger will
   * not say so, so this log is the only place the two numbers can be reconciled.
   */
  private warnClaimLost(
    claim: { claimToken: string; taskName: RetentionTaskName },
    deletedCounts: Record<string, number>,
    stage: 'complete' | 'fail',
  ): void {
    this.logger.warn({
      event: 'retention_claim_lost',
      taskName: claim.taskName,
      stage,
      errorCode: retentionErrorCodes.claimLost,
      deletedCounts,
    });
  }
}
