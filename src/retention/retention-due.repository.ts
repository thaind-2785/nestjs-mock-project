import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { RetentionWindowConfiguration } from '../config/retention.config';
import type { RetentionDuePredicate } from './retention-due';
import {
  microsecondsPerMillisecond,
  millisecondsPerHour,
} from './retention.constants';
import type { RetentionDueSample } from './retention.types';

/**
 * Reads what is due without touching it.
 *
 * The table and anchor column are interpolated rather than bound, which they have to
 * be - neither is a value. They are safe because they are not data: every one comes
 * from `retentionDuePredicates`, a frozen list in source, and nothing reaching this
 * method can add to it. Every actual value stays a bound parameter.
 *
 * Count and age come from one statement because they answer one question together: a
 * count that is large but young is a busy night, while a count that is small but old is
 * a task that is not running at all, and those need different responses. Two statements
 * could also disagree, having read the table a moment apart.
 */
@Injectable()
export class RetentionDueRepository {
  async sample(
    dataSource: DataSource,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
    statementTimeoutMs: number,
  ): Promise<RetentionDueSample> {
    // Inside a transaction, which is what pins the connection.
    //
    // `SET SESSION` is a property of one connection, and an unpinned `EntityManager`
    // borrows a different one per call - so the bound could land on connection A, the
    // read run unbounded on B, and the reset apply to C, leaving A carrying a
    // thirty-second ceiling for whatever unrelated feature draws it next. The export
    // snapshot reader wraps its bound for exactly this reason and says so; an earlier
    // version of this file copied the shape of that code and not the part that makes it
    // work.
    return dataSource.transaction(async (manager) => {
      await manager.query('SET SESSION MAX_EXECUTION_TIME = ?', [
        statementTimeoutMs,
      ]);
      try {
        return await this.readSample(manager, predicate, windows);
      } finally {
        // The bound belongs to this read, not to the connection it borrowed.
        await manager.query('SET SESSION MAX_EXECUTION_TIME = DEFAULT');
      }
    });
  }

  private async readSample(
    manager: EntityManager,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
  ): Promise<RetentionDueSample> {
    const rows: Array<{ due_count: number; oldest_age_us: string | number }> =
      await manager.query(
        `SELECT COUNT(*) AS due_count,
                COALESCE(
                  TIMESTAMPDIFF(MICROSECOND, MIN(${predicate.anchorColumn}), NOW(6)),
                  0
                ) AS oldest_age_us
         FROM ${predicate.table}
         WHERE ${predicate.where}`,
        predicate.parameters(windows),
      );
    const ageMs = Math.floor(
      Number(rows[0].oldest_age_us) / microsecondsPerMillisecond,
    );
    const windowMs = predicate.windowHours(windows) * millisecondsPerHour;
    return {
      dueCount: Number(rows[0].due_count),
      // How long the oldest row has been *overdue*, not how old it is. A row that became
      // due a minute ago reads as a minute, whatever its window - so a healthy task reads
      // near zero and a task that stopped running reads as the time since it stopped.
      oldestOverdueMs: Math.max(0, ageMs - windowMs),
    };
  }

  /**
   * Which indexes the optimiser considers usable for this predicate.
   *
   * `possible_keys` rather than `key`, deliberately. Whether the optimiser *chooses*
   * an index depends on how big the table is, and on a small one a full scan is
   * genuinely cheaper - so asserting `key` would assert something false about a
   * correct optimiser, and would have to be propped up with a fixture large enough to
   * change its mind. `possible_keys` answers the question that is actually being
   * asked: can this predicate be served from an index at all, or has it drifted onto a
   * column no index covers. That is the property that would silently turn the daily
   * count into a scan of every row the system has written.
   */
  async explain(
    manager: EntityManager,
    predicate: RetentionDuePredicate,
    windows: RetentionWindowConfiguration,
  ): Promise<{ possibleKeys: string[]; key: string | null }> {
    const rows: Array<{ possible_keys: string | null; key: string | null }> =
      await manager.query(
        `EXPLAIN SELECT COUNT(*), MIN(${predicate.anchorColumn})
         FROM ${predicate.table}
         WHERE ${predicate.where}`,
        predicate.parameters(windows),
      );
    return {
      possibleKeys: (rows[0]?.possible_keys ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
      key: rows[0]?.key ?? null,
    };
  }
}
