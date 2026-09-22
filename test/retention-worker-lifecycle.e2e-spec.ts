import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, Server, Socket } from 'node:net';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createRetentionConfiguration } from '../src/config/retention.config';
import { createTypeOrmOptions } from '../src/database/database.options';
import { ExportJobStatus } from '../src/reports/entities/export-job.enums';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import { roomExportEventTypes } from '../src/reports/room-export.constants';
import { retentionErrorCodes } from '../src/retention/retention.constants';
import { localDayStart } from '../src/retention/retention-window';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(180_000);

const exportEventType = roomExportEventTypes[0];

describe('P7-T04 retention scheduler as a process', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let baseEnvironment: NodeJS.ProcessEnv;
  let timeZone: string;
  let userId: string;
  const children = new Set<ChildProcess>();
  const workerOutput = new Map<ChildProcess, string>();
  const blackHoles = new Set<Server>();
  const blackHoleSockets = new Set<Socket>();

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p7_t04_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    timeZone = createRetentionConfiguration(environment).windows.timeZone;

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
        `Scheduler prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

    // Compiled here rather than assumed. `npm run verify` runs `build` after `e2e_test`,
    // so a clean checkout has no `dist/` when this suite runs and every worker exits 1
    // before it can start.
    execFileSync('npm', ['run', 'build'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });

    baseEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      MYSQL_DATABASE: disposableDatabase,
      RETENTION_ENABLED: 'true',
      // Their own namespaces, so a developer's local queues are neither read nor
      // disturbed by a worker that is here for retention.
      NOTIFICATION_QUEUE_PREFIX: `hotel:p7t04:${process.pid}:${randomUUID()}:mail`,
    };
    userId = await insertUser();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM scheduled_runs');
    await dataSource.query('DELETE FROM export_jobs');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM auth_sessions');
    await dataSource.query('DELETE FROM idempotency_keys');
  });

  afterEach(() => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
    workerOutput.clear();
    for (const socket of blackHoleSockets) socket.destroy();
    blackHoleSockets.clear();
    for (const server of blackHoles) server.close();
    blackHoles.clear();
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

  it('starts nothing when the scheduler is switched off', async () => {
    // The rollout deploys the code before it is allowed to delete, so a worker that
    // ticks anyway would make that step meaningless.
    const worker = startWorker({ RETENTION_ENABLED: 'false' });
    await waitForLog(worker, 'retention_scheduler_disabled', 60_000);
    await insertExpiredSession();

    // Long enough for several ticks, if there were any.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    expect(await countRuns()).toBe(0);
    expect(await count('auth_sessions')).toBe(1);
  });

  it('gives one window to one of two workers, and both keep running', async () => {
    await insertExpiredSession();
    const first = startWorker();
    const second = startWorker();
    await Promise.all([
      waitForLog(first, 'retention_scheduler_started', 60_000),
      waitForLog(second, 'retention_scheduler_started', 60_000),
    ]);

    // Waiting for five *rows* would race: `claim` inserts the row as `CLAIMED` before the
    // task deletes anything, and the five run serially inside one `runAll` - so the count
    // reaches five while the last task is still working, and asserting every row is
    // `SUCCEEDED` there fails intermittently on the test that proves the singleton.
    await waitFor(
      async () => (await countRunsWithStatus('SUCCEEDED')) === 5,
      60_000,
    );

    const rows = await readRuns();
    // Five tasks, five windows, one row each - whichever process won. Two rows for one
    // task would mean two processes deleting from the same table at once.
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => String(row.task_name))).size).toBe(5);
    expect(await count('auth_sessions')).toBe(0);
  });

  it('runs the current window once after a day down, not once per missed day', async () => {
    // Nothing recorded for yesterday: that is what "the worker was down" looks like.
    // Replaying missed windows would delete exactly the same rows again, because
    // retention is idempotent by predicate - whatever was due yesterday is still due.
    await insertExpiredSession();
    const worker = startWorker();
    await waitForLog(worker, 'retention_scheduler_started', 60_000);
    await waitFor(
      async () => (await countRunsWithStatus('SUCCEEDED')) === 5,
      60_000,
    );

    const today = localDayStart(await databaseNow(), timeZone);
    const windows = (await readRuns()).map((row) =>
      new Date(String(row.scheduled_for)).toISOString(),
    );
    expect(new Set(windows)).toEqual(new Set([today.toISOString()]));
  });

  it('samples a backlog an operator can act on', async () => {
    await insertExpiredSession();
    // A window nobody will pick up again. The due counts cannot show this: retention
    // can be stopped dead for a task while its backlog still looks calm.
    await insertFailedWindow('notification-events');

    const worker = startWorker();
    await waitForLog(worker, 'retention_backlog_sampled', 60_000);

    const sample = lastBacklogSample(worker);
    expect(sample).toBeDefined();
    // The five readings the runbook tells an operator to read.
    expect(sample).toHaveProperty('tasks');
    expect(sample).toHaveProperty('failedWindows');
    expect(sample).toHaveProperty('staleClaims');
    expect(sample).toHaveProperty('oldestFailedAgeMs');
    expect(Number((sample as { failedWindows: number }).failedWindows)).toBe(1);

    // Every task named, each with the pair that separates a busy night from a stopped
    // one - and nothing that would leak: no object key, no email, no row content.
    const tasks = (sample as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(5);
    for (const task of tasks) {
      expect(task).toHaveProperty('due');
      expect(task).toHaveProperty('oldestOverdueMs');
      expect(task).toHaveProperty('windowHours');
    }
    const serialized = JSON.stringify(sample);
    expect(serialized).not.toContain('exports/rooms');
    expect(serialized).not.toContain('@hotel.test');
  });

  it('hands the window back on SIGTERM instead of abandoning or completing it', async () => {
    // A job whose object the worker will try to delete, against an endpoint that accepts
    // the connection and answers nothing - so the run is provably inside a batch when
    // the signal arrives, rather than being caught by luck.
    await insertExpiredExportJob();
    const worker = startWorker({
      OBJECT_STORAGE_ENDPOINT: await startUnresponsiveStorage(),
    });
    await waitForLog(worker, 'retention_run_started', 60_000);

    worker.kill('SIGTERM');
    const code = await waitForExit(worker, 120_000);

    expect(workerOutput.get(worker)).toContain('"drained":true');
    expect(code).toBe(0);

    // The window is claimed with an expired lease and a code saying why - not SUCCEEDED,
    // which would clear it and let the unique key refuse every further claim today, and
    // not silently abandoned either.
    const [run] = (await readRuns()).filter(
      (row) => String(row.task_name) === 'export-results',
    );
    expect(String(run.status)).toBe('CLAIMED');
    expect(String(run.last_error_code)).toBe(retentionErrorCodes.shutdown);
    expect(await count('export_jobs')).toBe(1);
  });

  it('lets the other worker finish a window whose process was killed, once', async () => {
    // The case the phase was planned around and never got: a worker that dies without
    // running a single line of shutdown code. `SIGTERM` proves the handback path; this
    // proves the path that has no code in it at all, where the only thing standing
    // between a half-done window and a lost one is the lease.
    await insertExpiredExportJob();
    const killed = startWorker({
      OBJECT_STORAGE_ENDPOINT: await startUnresponsiveStorage(),
    });
    // Waiting for this task's own claim rather than for the first `retention_run_started`
    // line: the five tasks run serially, so the first line belongs to whichever runs
    // first and the kill would land wherever it landed. The black-holed endpoint holds
    // the process inside this batch until it is signalled.
    await waitFor(
      async () =>
        (await readRuns()).some(
          (row) =>
            String(row.task_name) === 'export-results' &&
            String(row.status) === 'CLAIMED',
        ),
      60_000,
    );
    killed.kill('SIGKILL');
    await waitForExit(killed, 60_000);

    const abandoned = await readRun('export-results');
    expect(String(abandoned.status)).toBe('CLAIMED');
    expect(Number(abandoned.attempts)).toBe(1);
    // Nothing was deleted: the object delete never answered, so the job is still there
    // and the window is still owed.
    expect(await count('export_jobs')).toBe(1);

    // Five and a half minutes of wall clock, applied rather than waited out. The lease
    // is sized against the run budget, and what a takeover needs from it is only that it
    // has expired; the ledger suite covers the expiry itself. Scoped to CLAIMED because
    // a finished row holding a lease is a state the table's check constraint forbids.
    await dataSource.query(
      "UPDATE scheduled_runs SET lock_expires_at = NOW(6) WHERE status = 'CLAIMED'",
    );

    // Not held: `afterEach` kills every worker this suite started, and nothing here
    // signals it individually.
    startWorker();
    await waitFor(
      async () => (await countRunsWithStatus('SUCCEEDED')) === 5,
      120_000,
    );

    const recovered = await readRun('export-results');
    // One row, a second attempt on it: the window was taken over rather than started
    // again beside the first, which is the difference between recovery and two workers
    // deleting from one table at once.
    expect(Number(recovered.attempts)).toBe(2);
    expect(await countRuns()).toBe(5);
    // And the job is gone exactly once. The ledger accumulates across attempts, so a
    // second deletion of the same row - or a replayed window - would read as two here
    // even though the table can only ever reach zero.
    expect(
      (recovered.deleted_counts as { export_jobs?: number }).export_jobs,
    ).toBe(1);
    expect(await count('export_jobs')).toBe(0);
  });

  // --- helpers ---

  function startWorker(overrides: NodeJS.ProcessEnv = {}): ChildProcess {
    const child = spawn('node', ['dist/worker'], {
      cwd: process.cwd(),
      env: { ...baseEnvironment, ...overrides },
      // stderr is kept: a worker that dies on startup says why there and nowhere else.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    workerOutput.set(child, '');
    const collect = (chunk: Buffer) => {
      workerOutput.set(
        child,
        (workerOutput.get(child) ?? '') + chunk.toString('utf8'),
      );
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    return child;
  }

  /**
   * A storage endpoint that completes the handshake and then says nothing, so a delete
   * against it neither succeeds nor fails and the run stays inside its batch until the
   * process is signalled. This is what makes "interrupted mid-run" a decision rather
   * than a race.
   */
  async function startUnresponsiveStorage(): Promise<string> {
    const server = createServer((socket) => {
      blackHoleSockets.add(socket);
    });
    blackHoles.add(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('unresponsive storage did not bind a port');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /**
   * Waits on a whole log line, which unlike a row does not stop being true.
   *
   * The newline matters: a substring match can resolve while the buffer still ends mid
   * line, and a reader that then splits and parses the last element gets a `SyntaxError`
   * for a reason unrelated to the behaviour under test.
   */
  async function waitForLog(
    child: ChildProcess,
    marker: string,
    timeoutMs: number,
  ): Promise<void> {
    await waitFor(
      () =>
        Promise.resolve(
          (workerOutput.get(child) ?? '')
            .split('\n')
            .some((line, index, lines) =>
              line.includes(marker) ? index < lines.length - 1 : false,
            ),
        ),
      timeoutMs,
      () =>
        Promise.resolve(
          `waiting for ${marker}; worker said: ${workerOutput.get(child) ?? ''}`,
        ),
    );
  }

  function waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('worker did not exit in time')),
        timeoutMs,
      );
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
  }

  async function waitFor(
    condition: () => Promise<boolean>,
    timeoutMs: number,
    describe?: () => Promise<string>,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() >= deadline) {
        const observed = describe ? `: ${await describe()}` : '';
        throw new Error(`condition was not met in time${observed}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function databaseNow(): Promise<Date> {
    const rows: Array<{ now: Date }> = await dataSource.query(
      'SELECT NOW(6) AS now',
    );
    return new Date(rows[0].now);
  }

  async function insertUser(): Promise<string> {
    const inserted: { insertId: number } = await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Retention Admin', 'ADMIN', 'ACTIVE', NOW(6))`,
      [`retention-${randomUUID()}@hotel.test`],
    );
    return String(inserted.insertId);
  }

  async function insertExpiredSession(): Promise<void> {
    await dataSource.query(
      `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, refresh_expires_at)
       VALUES (?, ?, ?, NOW(6) - INTERVAL 30 DAY)`,
      [randomUUID(), userId, randomUUID().replaceAll('-', '')],
    );
  }

  async function insertExpiredExportJob(): Promise<void> {
    const eventId = randomUUID();
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key, processed_at)
       VALUES (?, ?, '{}', NOW(6), ?, ?, NOW(6))`,
      [eventId, exportEventType, OutboxEventStatus.Processed, randomUUID()],
    );
    await dataSource.query(
      `INSERT INTO export_jobs
         (id, requested_by, outbox_event_id, status, filters, object_key, row_count,
          file_size_bytes, content_sha256, started_at, completed_at, expires_at,
          updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, 5, 1024, ?, NOW(6), NOW(6), NOW(6),
               NOW(6) - INTERVAL 60 DAY)`,
      [
        randomUUID(),
        userId,
        eventId,
        ExportJobStatus.Completed,
        `exports/rooms/${randomUUID()}.xlsx`,
        '0'.repeat(64),
      ],
    );
  }

  /** The most recent sample this process wrote, read from its own log. */
  function lastBacklogSample(child: ChildProcess): unknown {
    const lines = (workerOutput.get(child) ?? '')
      .split('\n')
      .filter((line) => line.includes('retention_backlog_sampled'));
    const last = lines[lines.length - 1];
    if (last === undefined) return undefined;
    const parsed: { message?: unknown } = JSON.parse(last) as {
      message?: unknown;
    };
    return parsed.message;
  }

  async function insertFailedWindow(taskName: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO scheduled_runs
         (id, task_name, scheduled_for, status, attempts, started_at, finished_at,
          last_error_code)
       VALUES (?, ?, NOW(6) - INTERVAL 2 DAY, 'FAILED', 3, NOW(6), NOW(6), ?)`,
      [randomUUID(), taskName, retentionErrorCodes.runAbandoned],
    );
  }

  async function readRuns(): Promise<Array<Record<string, unknown>>> {
    return dataSource.query('SELECT * FROM scheduled_runs');
  }

  async function readRun(taskName: string): Promise<Record<string, unknown>> {
    const [row] = (await readRuns()).filter(
      (candidate) => String(candidate.task_name) === taskName,
    );
    if (!row) throw new Error(`No ledger row for ${taskName}`);
    return row;
  }

  async function countRuns(): Promise<number> {
    return count('scheduled_runs');
  }

  async function countRunsWithStatus(status: string): Promise<number> {
    const rows: Array<{ total: number }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM scheduled_runs WHERE status = ?',
      [status],
    );
    return Number(rows[0].total);
  }

  async function count(table: string): Promise<number> {
    const rows: Array<{ total: number }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM ${table}`,
    );
    return Number(rows[0].total);
  }
});
