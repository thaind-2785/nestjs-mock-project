import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { ScheduledRunStatus } from '../src/retention/entities/scheduled-run.enums';
import {
  retentionErrorCodes,
  type RetentionTaskName,
} from '../src/retention/retention.constants';
import { localDayStart } from '../src/retention/retention-window';
import { ScheduledRunRepository } from '../src/retention/scheduled-run.repository';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(60_000);

const taskName: RetentionTaskName = 'auth-sessions';
const leaseMs = 600_000;
const maxAttempts = 3;

describe('Phase 7 run ledger and singleton claim', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let runs: ScheduledRunRepository;
  let window: Date;

  // Built once. Every test here works on one table, so rebuilding the whole migration
  // stack per test bought nothing and cost eighteen runs of it; the rows go between
  // tests instead. The schema test reapplies what it reverts, so it leaves the stack as
  // it found it.
  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p7_t01_${process.pid}_${randomUUID().replaceAll('-', '')}`;

    try {
      adminConnection = await mysql.createConnection({
        host: environment.MYSQL_HOST,
        port: environment.MYSQL_PORT,
        user: 'root',
        password:
          process.env.MYSQL_ROOT_PASSWORD ?? 'local_mysql_root_change_me',
      });
      await adminConnection.query(
        `CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await adminConnection.query(
        `GRANT ALL PRIVILEGES ON \`${disposableDatabase}\`.* TO '${environment.MYSQL_USER}'@'%'`,
      );
    } catch (error) {
      throw new Error(
        `Run ledger prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        { migrations: applicationMigrations },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    runs = new ScheduledRunRepository();
    // The window comes from the database clock, exactly as the scheduler will read it.
    window = localDayStart(await databaseNow(), environment.HOTEL_TIMEZONE);
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM scheduled_runs');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (adminConnection && disposableDatabase) {
      try {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
        );
      } finally {
        await adminConnection.end();
      }
    }
  });

  describe('schema', () => {
    it('applies onto a Phase 6 database and reverts before any run exists', async () => {
      expect(await tableExists('scheduled_runs')).toBe(true);
      // Additive: Phase 6 is untouched, which is what lets this be deployed ahead of
      // the code that reads it.
      expect(await tableExists('export_jobs')).toBe(true);

      await dataSource.undoLastMigration();
      expect(await tableExists('scheduled_runs')).toBe(false);
      expect(await tableExists('export_jobs')).toBe(true);

      await dataSource.runMigrations();
      expect(await tableExists('scheduled_runs')).toBe(true);
    });

    it('refuses a row that claims to be running with no owner', async () => {
      // The state check, not the service, is what makes this impossible. A row like
      // this would sit in the recoverable index forever with nothing to recover.
      await expect(
        dataSource.query(
          `INSERT INTO scheduled_runs
             (id, task_name, scheduled_for, status, attempts, started_at)
           VALUES (?, ?, ?, ?, 1, NOW(6))`,
          [randomUUID(), taskName, window, ScheduledRunStatus.Claimed],
        ),
      ).rejects.toThrow();
    });

    it('carries one index per question it answers, and no duplicate', async () => {
      // The unique key is also the history index: same columns, same order. A second
      // one would be maintained on every claim and read by nothing, and because the
      // duplication was mirrored in the entity a schema check would not have seen it.
      const rows: Array<{ INDEX_NAME: string }> = await dataSource.query(
        `SELECT DISTINCT INDEX_NAME FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = 'scheduled_runs'`,
        [disposableDatabase],
      );
      expect(rows.map((row) => row.INDEX_NAME).sort()).toEqual([
        'PRIMARY',
        'idx_scheduled_runs_recoverable',
        'uq_scheduled_runs_window',
      ]);
    });

    it('refuses a finished row that still holds a lease', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO scheduled_runs
             (id, task_name, scheduled_for, status, locked_by, lock_expires_at,
              attempts, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, NOW(6), 1, NOW(6), NOW(6))`,
          [
            randomUUID(),
            taskName,
            window,
            ScheduledRunStatus.Succeeded,
            randomUUID(),
          ],
        ),
      ).rejects.toThrow();
    });
  });

  describe('the election', () => {
    it('gives one window to exactly one of two concurrent claimers', async () => {
      // Both statements are in flight before either resolves, which is the shape two
      // replicas ticking at the same second produce. Nothing here serialises them.
      const [first, second] = await Promise.all([
        runs.claim(dataSource, {
          taskName,
          scheduledFor: window,
          leaseMs,
          maxAttempts,
        }),
        runs.claim(dataSource, {
          taskName,
          scheduledFor: window,
          leaseMs,
          maxAttempts,
        }),
      ]);

      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(['claimed', 'refused']);
      // The loser is refused, not failed. Losing an election is the normal outcome for
      // every replica but one, so it must not surface as an error.
      const loser = first.outcome === 'refused' ? first : second;
      expect(loser.outcome === 'refused' && loser.reason).toBe('taken');
      expect(await countRuns()).toBe(1);
    });

    it('refuses the loser rather than throwing, even while the winner is mid-transaction', async () => {
      // The case the autocommit test above cannot reach. Inside a transaction the
      // winner's unique-key lock is uncommitted, so the loser's insert does not get a
      // duplicate key - it blocks, and MySQL raises `ERROR 1205` after
      // `innodb_lock_wait_timeout`. Measured, not reasoned: two transactions inserting
      // the same key give the second 1205, not 1062.
      //
      // The ledger therefore never runs inside a caller's transaction, and this proves
      // that holding one somewhere else cannot turn an ordinary lost election into a
      // crash.
      await dataSource.query('SET SESSION innodb_lock_wait_timeout = 2');
      const holder = dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query(
          `INSERT INTO scheduled_runs
             (id, task_name, scheduled_for, status, locked_by, lock_expires_at,
              attempts, started_at)
           VALUES (?, ?, ?, 'CLAIMED', ?, NOW(6) + INTERVAL 10 MINUTE, 1, NOW(6))`,
          [randomUUID(), taskName, window, randomUUID()],
        );

        const loser = await runs.claim(dataSource, {
          taskName,
          scheduledFor: window,
          leaseMs,
          maxAttempts,
        });
        expect(loser.outcome === 'refused' && loser.reason).toBe('taken');
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }
    });

    it('lets a different task claim the same window', async () => {
      // The key is (task_name, scheduled_for), so the five tasks are independent: one
      // failing task must not hold up the other four.
      const sessions = await runs.claim(dataSource, {
        taskName,
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      const keys = await runs.claim(dataSource, {
        taskName: 'idempotency-keys',
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      expect(sessions.outcome).toBe('claimed');
      expect(keys.outcome).toBe('claimed');
      expect(await countRuns()).toBe(2);
    });

    it('refuses a window that already succeeded', async () => {
      const claim = await claimOrThrow();
      expect(await runs.complete(dataSource, claim, { auth_sessions: 4 })).toBe(
        true,
      );

      const again = await runs.claim(dataSource, {
        taskName,
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      expect(again.outcome === 'refused' && again.reason).toBe('taken');
      // Idempotence of the window, not of the deletion: yesterday's rows are still
      // due tomorrow, so a second run today would only repeat work.
      expect(await countRuns()).toBe(1);
    });
  });

  describe('recovery', () => {
    it('hands an expired lease to another replica and counts the attempt', async () => {
      const dead = await claimOrThrow();
      await expireLease();

      const recovered = await runs.claim(dataSource, {
        taskName,
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      expect(recovered.outcome).toBe('claimed');
      if (recovered.outcome !== 'claimed') return;
      expect(recovered.claim.attempt).toBe(2);
      expect(recovered.claim.claimToken).not.toBe(dead.claimToken);
      // One row throughout: recovery takes the window over rather than opening a
      // second run for the same day.
      expect(await countRuns()).toBe(1);
    });

    it('stops the replica whose lease expired from finalizing over its successor', async () => {
      const dead = await claimOrThrow();
      await expireLease();
      const recovered = await claimOrThrow();

      // The dead replica finishes its work and tries to record it. Its token no longer
      // matches, so it writes nothing at all - rather than marking a window succeeded
      // while another process is still deleting inside it.
      // The rows it names really were deleted and the ledger will not say so, so this
      // line is the only place the two numbers can ever be reconciled.
      const logged = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      expect(await runs.complete(dataSource, dead, { auth_sessions: 10 })).toBe(
        false,
      );
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'retention_claim_lost',
          stage: 'complete',
          deletedCounts: { auth_sessions: 10 },
        }),
      );
      logged.mockRestore();
      const row = await readRun();
      expect(row.status).toBe(ScheduledRunStatus.Claimed);
      expect(row.locked_by).toBe(recovered.claimToken);
      expect(row.deleted_counts).toBeNull();
    });

    it('keeps saying exhausted on every tick, not just the one that noticed', async () => {
      await claimOrThrow();
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        await expireLease();
        await claimOrThrow();
      }
      await expireLease();

      const noticed = await runs.claim(dataSource, {
        taskName,
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      expect(noticed.outcome === 'refused' && noticed.reason).toBe('exhausted');

      // Every tick afterwards asks the same question and must get the same answer. A
      // scheduler that alerts on `exhausted` would otherwise announce a dead task once
      // and then describe it as ordinary for the rest of the day - the silent failure
      // the FAILED status exists to prevent.
      for (let tick = 0; tick < 3; tick += 1) {
        const again = await runs.claim(dataSource, {
          taskName,
          scheduledFor: window,
          leaseMs,
          maxAttempts,
        });
        expect(again.outcome === 'refused' && again.reason).toBe('exhausted');
      }
    });

    it('refuses to finalize past its own lease even when nobody has taken over', async () => {
      const claim = await claimOrThrow();
      await expireLease();

      // Nobody recovered it, so `locked_by` is still this replica's token and the lease
      // is the only thing refusing the write. That case is the whole reason the lease
      // is in the predicate: the sibling test above passes on the token alone, so
      // deleting `lock_expires_at > NOW(6)` from `complete` left every assertion green
      // until this one existed.
      //
      // Past its lease a replica owns nothing, because another could have taken the
      // window over at any moment while it was working - and recording success would
      // hide that two processes had been deleting from the same tables at once.
      expect(await runs.complete(dataSource, claim, { auth_sessions: 1 })).toBe(
        false,
      );
      const row = await readRun();
      expect(row.status).toBe(ScheduledRunStatus.Claimed);
      expect(row.deleted_counts).toBeNull();
    });

    it('refuses to record a failure past its own lease', async () => {
      const claim = await claimOrThrow();
      await expireLease();

      // Same rule on the other path. The row stays claimed with an expired lease, so
      // the next tick recovers it - rather than this replica closing a window it had
      // already stopped owning.
      expect(
        await runs.fail(
          dataSource,
          claim,
          { errorCode: retentionErrorCodes.taskFailed, retryable: false },
          {},
          maxAttempts,
        ),
      ).toBe(false);
      expect((await readRun()).status).toBe(ScheduledRunStatus.Claimed);
    });

    it('closes a window whose process died with its budget spent', async () => {
      await claimOrThrow();
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        await expireLease();
        await claimOrThrow();
      }
      // Third attempt is claimed and now dies too.
      await expireLease();

      // The loudest transition this module makes, and it used to make it silently.
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const refused = await runs.claim(dataSource, {
        taskName,
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      // Somebody has to write this down, because the process that died could not.
      // Left alone it would look like work in progress forever.
      expect(refused.outcome === 'refused' && refused.reason).toBe('exhausted');
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'retention_run_abandoned',
          taskName,
          errorCode: retentionErrorCodes.runAbandoned,
        }),
      );
      logged.mockRestore();
      const row = await readRun();
      expect(row.status).toBe(ScheduledRunStatus.Failed);
      expect(row.last_error_code).toBe(retentionErrorCodes.runAbandoned);
      expect(row.locked_by).toBeNull();
      expect(row.finished_at).not.toBeNull();
    });
  });

  describe('outcomes', () => {
    it('records what a successful run deleted, per table', async () => {
      const claim = await claimOrThrow();
      expect(
        await runs.complete(dataSource, claim, {
          auth_sessions: 120,
          idempotency_keys: 0,
        }),
      ).toBe(true);

      const row = await readRun();
      expect(row.status).toBe(ScheduledRunStatus.Succeeded);
      expect(row.deleted_counts).toEqual({
        auth_sessions: 120,
        idempotency_keys: 0,
      });
      expect(row.last_error_code).toBeNull();
      expect(row.locked_by).toBeNull();
    });

    it('hands the window back by expiring its own lease when the failure is retryable', async () => {
      const claim = await claimOrThrow();
      expect(
        await runs.fail(
          dataSource,
          claim,
          { errorCode: retentionErrorCodes.taskFailed, retryable: true },
          { auth_sessions: 300 },
          maxAttempts,
        ),
      ).toBe(true);

      const row = await readRun();
      // Still claimed, and still carrying why the last attempt stopped. Making the
      // retry path identical to the crash-recovery path means there is one mechanism
      // to get right rather than two that have to agree.
      expect(row.status).toBe(ScheduledRunStatus.Claimed);
      expect(row.last_error_code).toBe(retentionErrorCodes.taskFailed);
      // The three hundred rows it did delete are recorded. A run that deleted work and
      // then failed deleted that work.
      expect(row.deleted_counts).toEqual({ auth_sessions: 300 });

      const next = await runs.claim(dataSource, {
        taskName,
        scheduledFor: window,
        leaseMs,
        maxAttempts,
      });
      expect(next.outcome).toBe('claimed');
      if (next.outcome === 'claimed') expect(next.claim.attempt).toBe(2);
    });

    it('adds each attempt to the window total instead of replacing it', async () => {
      const first = await claimOrThrow();
      await runs.fail(
        dataSource,
        first,
        { errorCode: retentionErrorCodes.statementTimeout, retryable: true },
        { auth_sessions: 300 },
        maxAttempts,
      );

      const second = await claimOrThrow();
      expect(
        await runs.complete(dataSource, second, { auth_sessions: 50 }),
      ).toBe(true);

      const row = await readRun();
      // 350, not 50. The ledger is the only durable record that data was deleted, and
      // an attempt that removed three hundred rows removed three hundred rows whether
      // or not it was the attempt that finished.
      expect(row.deleted_counts).toEqual({ auth_sessions: 350 });
      // And the reason the window needed a second attempt survives its success, so one
      // row still tells the whole story.
      expect(row.status).toBe(ScheduledRunStatus.Succeeded);
      expect(row.last_error_code).toBe(retentionErrorCodes.statementTimeout);
      expect(row.attempts).toBe(2);
    });

    it('closes the window when the failure is permanent, whatever the budget', async () => {
      const claim = await claimOrThrow();
      expect(
        await runs.fail(
          dataSource,
          claim,
          { errorCode: retentionErrorCodes.claimLost, retryable: false },
          {},
          maxAttempts,
        ),
      ).toBe(true);

      const row = await readRun();
      expect(row.status).toBe(ScheduledRunStatus.Failed);
      expect(row.last_error_code).toBe(retentionErrorCodes.claimLost);
      expect(row.finished_at).not.toBeNull();
    });

    it('closes the window when a retryable failure spends the last attempt', async () => {
      await claimOrThrow();
      for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
        await expireLease();
        await claimOrThrow();
      }
      const last = await readRun();
      expect(last.attempts).toBe(maxAttempts);

      const claim = {
        claimToken: String(last.locked_by),
        attempt: Number(last.attempts),
        taskName,
      };
      await runs.fail(
        dataSource,
        claim,
        { errorCode: retentionErrorCodes.taskFailed, retryable: true },
        {},
        maxAttempts,
      );
      const row = await readRun();
      // Retryable is about the error, not about the budget. A task that fails three
      // times is a task an operator has to look at.
      expect(row.status).toBe(ScheduledRunStatus.Failed);
      expect(row.last_error_code).toBe(retentionErrorCodes.taskFailed);
    });
  });

  async function claimOrThrow() {
    const result = await runs.claim(dataSource, {
      taskName,
      scheduledFor: window,
      leaseMs,
      maxAttempts,
    });
    if (result.outcome !== 'claimed') {
      throw new Error(`expected a claim, got ${result.reason}`);
    }
    return result.claim;
  }

  /**
   * Expires the lease in SQL rather than waiting ten minutes for one.
   *
   * The lease is a constant and what is under test is what a second replica does with
   * an expired one, not how long the clock takes to produce it. It is set from the
   * database clock so the predicate that reads it and the statement that writes it
   * agree on what time it is.
   */
  async function expireLease(): Promise<void> {
    await dataSource.query(
      `UPDATE scheduled_runs SET lock_expires_at = NOW(6) - INTERVAL 1 SECOND
       WHERE task_name = ? AND scheduled_for = ?`,
      [taskName, window],
    );
  }

  async function databaseNow(): Promise<Date> {
    const rows: Array<{ now: Date }> = await dataSource.query(
      'SELECT NOW(6) AS now',
    );
    return new Date(rows[0].now);
  }

  async function readRun(): Promise<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      'SELECT * FROM scheduled_runs WHERE task_name = ? AND scheduled_for = ?',
      [taskName, window],
    );
    return rows[0];
  }

  async function countRuns(): Promise<number> {
    const rows: Array<{ total: number }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM scheduled_runs',
    );
    return Number(rows[0].total);
  }

  async function tableExists(name: string): Promise<boolean> {
    const rows: Array<{ total: number }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ?`,
      [disposableDatabase, name],
    );
    return Number(rows[0].total) > 0;
  }
});
