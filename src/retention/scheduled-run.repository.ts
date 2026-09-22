import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  retentionErrorCodes,
  type RetentionTaskName,
} from './retention.constants';
import { ScheduledRunStatus } from './entities/scheduled-run.enums';
import type {
  ScheduledRunClaimResult,
  ScheduledRunFailure,
} from './scheduled-run.types';

/** MySQL's duplicate-key error. Losing an election raises it, so it is an outcome
 * rather than a fault, and only this one code may be read that way. */
const duplicateEntryErrno = 1062;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { errno?: number }).errno === duplicateEntryErrno
  );
}

/**
 * Every write a scheduled run makes to its own ledger row.
 *
 * Two rules run through all of it. The first is that the claim is an insert: a window
 * is won by being the replica whose `INSERT` the unique key accepted, not by holding a
 * lock. The second is that no statement after that changes anything unless the caller
 * still holds the token it was given - a run whose lease expired mid-work matches zero
 * rows and finishes nothing, rather than finalizing on top of whoever recovered it.
 *
 * The claim token alone carries that predicate. It is a fresh UUID per claim, so a
 * recovery replaces it and the previous holder's writes stop matching; there is no
 * need to thread an attempt number through as a second guard.
 *
 * The caller owns the `EntityManager` because these writes share a transaction with
 * the deletions they account for.
 */
@Injectable()
export class ScheduledRunRepository {
  /**
   * Wins, recovers, or loses one window.
   *
   * The order is deliberate. The insert is tried first because it is the common case
   * and needs no read: on an untouched window exactly one replica succeeds and the
   * rest learn they lost from the database rather than from a race they had to observe.
   * Only after losing does this look at why, and there are three reasons - somebody is
   * working on it, somebody finished it, or a previous attempt died and left a lease
   * that has since expired. The third is the only one that yields a claim.
   */
  async claim(
    manager: EntityManager,
    input: {
      taskName: RetentionTaskName;
      scheduledFor: Date;
      leaseMs: number;
      maxAttempts: number;
    },
  ): Promise<ScheduledRunClaimResult> {
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
          input.leaseMs * 1_000,
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
      if (!isDuplicateKey(error)) throw error;
    }
    return this.recover(manager, { ...input, claimToken });
  }

  /**
   * Takes over a window whose previous attempt died, or says why it cannot.
   *
   * `lock_expires_at <= NOW(6)` is part of the predicate rather than a check
   * afterwards: a lease that is still live belongs to whoever holds it, and finding
   * that out after starting to delete would be too late. `attempts < ?` is what stops
   * a task that crashes every time from being retried on every tick forever.
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
           attempts = attempts + 1,
           started_at = NOW(6)
       WHERE task_name = ?
         AND scheduled_for = ?
         AND status = ?
         AND lock_expires_at <= NOW(6)
         AND attempts < ?`,
      [
        input.claimToken,
        input.leaseMs * 1_000,
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
    return {
      outcome: 'refused',
      reason: (abandoned.affectedRows ?? 0) > 0 ? 'exhausted' : 'taken',
    };
  }

  /**
   * Records a finished run and releases the window.
   *
   * `false` means the claim was gone - the lease expired while the run was working and
   * another replica took it over. Nothing is written in that case, because the counts
   * this run is reporting describe deletions the new owner is about to redo.
   */
  async complete(
    manager: EntityManager,
    claim: { claimToken: string },
    deletedCounts: Record<string, number>,
  ): Promise<boolean> {
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE scheduled_runs
       SET status = ?,
           locked_by = NULL,
           lock_expires_at = NULL,
           finished_at = NOW(6),
           deleted_counts = ?,
           last_error_code = NULL
       WHERE locked_by = ?
         AND status = ?
         AND lock_expires_at > NOW(6)`,
      [
        ScheduledRunStatus.Succeeded,
        JSON.stringify(deletedCounts),
        claim.claimToken,
        ScheduledRunStatus.Claimed,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  /**
   * Records a failed run, and decides whether the window is handed back or closed.
   *
   * A retryable failure with budget left hands the window back by expiring its own
   * lease, which makes the retry path and the crash-recovery path the same mechanism
   * rather than two that have to agree. Anything else is terminal and loud.
   *
   * The counts are recorded either way: a run that deleted three hundred rows and then
   * failed deleted three hundred rows, and an operator reading the row needs to know
   * that rather than infer it.
   */
  async fail(
    manager: EntityManager,
    claim: { claimToken: string; attempt: number },
    failure: ScheduledRunFailure,
    deletedCounts: Record<string, number>,
    maxAttempts: number,
  ): Promise<boolean> {
    const handBack = failure.retryable && claim.attempt < maxAttempts;
    const result: { affectedRows?: number } = await manager.query(
      handBack
        ? `UPDATE scheduled_runs
           SET lock_expires_at = NOW(6),
               deleted_counts = ?,
               last_error_code = ?
           WHERE locked_by = ?
             AND status = ?
             AND lock_expires_at > NOW(6)`
        : `UPDATE scheduled_runs
           SET status = ?,
               locked_by = NULL,
               lock_expires_at = NULL,
               finished_at = NOW(6),
               deleted_counts = ?,
               last_error_code = ?
           WHERE locked_by = ?
             AND status = ?
             AND lock_expires_at > NOW(6)`,
      handBack
        ? [
            JSON.stringify(deletedCounts),
            failure.errorCode,
            claim.claimToken,
            ScheduledRunStatus.Claimed,
          ]
        : [
            ScheduledRunStatus.Failed,
            JSON.stringify(deletedCounts),
            failure.errorCode,
            claim.claimToken,
            ScheduledRunStatus.Claimed,
          ],
    );
    return (result.affectedRows ?? 0) > 0;
  }
}
