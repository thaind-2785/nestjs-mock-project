import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createObjectStorageClientOptions } from '../src/common/storage/object-storage-client';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createObjectStorageConfiguration } from '../src/config/object-storage.config';
import { createTypeOrmOptions } from '../src/database/database.options';
import { ExportJobStatus } from '../src/reports/entities/export-job.enums';
import { reportsWorkerEntities } from '../src/reports/reports-worker.entities';
import { roomExportEventType } from '../src/reports/room-export.constants';
import { RoomStatus } from '../src/rooms/entities/room.enums';
import { applicationMigrations } from './fixtures/application-migrations';
import { ensureAttachmentBucket } from './fixtures/room-images';

jest.setTimeout(180_000);

/**
 * The export worker as a process, not as a class.
 *
 * Everything else in this phase constructs the consumer and calls it. These spawn
 * `dist/worker`, let it do real work against real MySQL, Redis and MinIO, and then take
 * it away at a point that matters. A crash is not a rejected promise: the process stops
 * between two statements with its lease still held, and what happens next is decided by
 * rows rather than by anything still running.
 */
describe('P6-T07 export worker lifecycle under failure', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let queuePrefix: string;
  let baseEnvironment: NodeJS.ProcessEnv;
  let s3: S3Client;
  let bucket: string;
  let adminId: string;
  const children = new Set<ChildProcess>();
  const workerOutput = new Map<ChildProcess, string>();

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p6_t07_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    queuePrefix = `hotel:p6t07:${process.pid}:${randomUUID().replaceAll('-', '')}`;

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
      await ensureAttachmentBucket(environment);
    } catch (error) {
      throw new Error(
        `Export worker lifecycle prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const storage = createObjectStorageConfiguration(environment);
    bucket = storage.bucket;
    s3 = new S3Client(createObjectStorageClientOptions(storage));
    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        { entities: reportsWorkerEntities, migrations: applicationMigrations },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    baseEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      MYSQL_DATABASE: disposableDatabase,
      REPORT_EXPORT_ENABLED: 'true',
      REPORT_EXPORT_QUEUE_PREFIX: queuePrefix,
      // Its own namespace, so a developer's local queue is neither read nor disturbed.
      NOTIFICATION_QUEUE_PREFIX: `${queuePrefix}:mail`,
      // Fast enough that a test does not wait a second per poll.
      REPORT_EXPORT_POLL_INTERVAL_MS: '200',
      NOTIFICATION_POLL_INTERVAL_MS: '200',
      // One event per claim, so a single poll cannot take the whole backlog and leave
      // the second worker nothing to contend for.
      REPORT_EXPORT_CLAIM_BATCH_SIZE: '1',
      REPORT_EXPORT_BACKLOG_SAMPLE_INTERVAL_MS: '5000',
    };
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM storage_cleanup_tasks');
    await dataSource.query('DELETE FROM export_jobs');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM room_amenities');
    await dataSource.query('DELETE FROM rooms');
    await dataSource.query('DELETE FROM room_types');
    await dataSource.query('DELETE FROM users');
    const inserted: { insertId: number } = await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Export Admin', 'ADMIN', 'ACTIVE', NOW(6))`,
      [`export-${randomUUID()}@hotel.test`],
    );
    adminId = String(inserted.insertId);
    const typeId = await insertRoomType();
    for (let index = 0; index < 5; index += 1) {
      await insertRoom(typeId, `A-${index}`);
    }
  });

  afterEach(async () => {
    for (const child of children) child.kill('SIGKILL');
    children.clear();
    workerOutput.clear();
    // BullMQ state outlives the process that wrote it, so a job left behind would be
    // consumed by the next test's worker and its assertions would be about work this
    // test created.
    await obliterateQueue();
  });

  afterAll(async () => {
    s3?.destroy();
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

  it('carries one export from a durable row to a downloadable object', async () => {
    const { jobId } = await seedQueuedJob();
    const worker = startWorker();
    await waitForWorkerReady(worker);

    await waitFor(
      async () => (await readJob(jobId)).status === ExportJobStatus.Completed,
      60_000,
    );

    const job = await readJob(jobId);
    expect(Number(job.row_count)).toBe(5);
    expect(Number(job.file_size_bytes)).toBeGreaterThan(0);
    // The object exists in the private bucket with the length the job recorded.
    const stored = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: String(job.object_key) }),
    );
    expect(Number(stored.ContentLength)).toBe(Number(job.file_size_bytes));
    // The winning attempt removed its own safeguard, so cleanup will not delete the
    // object the job now points at.
    expect(await countSafeguards()).toBe(0);
  });

  it('recovers an export whose worker was killed outright', async () => {
    // The lease is what makes this work: the process stops holding a claim it can no
    // longer act on, and nothing in the database knows or needs to. A second worker
    // finds the lease expired and takes it.
    const { jobId, eventId } = await seedQueuedJob();
    const first = startWorker();
    await waitForWorkerReady(first);
    await waitFor(
      async () => (await readEvent(eventId)).status === 'PROCESSING',
      30_000,
    );

    first.kill('SIGKILL');
    await waitForExit(first, 30_000);
    // The row is left mid-attempt, claimed by a process that no longer exists.
    expect((await readEvent(eventId)).locked_by).not.toBeNull();

    // The lease is a constant rather than a setting - 180 seconds, checked against the
    // stages it covers - so this expires it rather than waiting three minutes for one.
    // What is under test is what a second worker does with an expired lease, not how
    // long the clock takes to produce one.
    await dataSource.query(
      'UPDATE outbox_events SET lock_expires_at = NOW(6) - INTERVAL 1 SECOND WHERE id = ?',
      [eventId],
    );

    const second = startWorker();
    await waitForWorkerReady(second);
    await waitFor(
      async () => (await readJob(jobId)).status === ExportJobStatus.Completed,
      60_000,
    );

    // One result, published by the worker that recovered it. Whatever the killed
    // attempt had uploaded is covered by its own safeguard and is not what the job
    // points at - the staging key carries the claim token, so the two cannot collide.
    expect(await countJobsWithStatus(ExportJobStatus.Completed)).toBe(1);
    expect(completionsLoggedBy(second)).toBe(1);
    const published = String((await readJob(jobId)).object_key);
    const safeguards = (await readSafeguards()).map((row) => row.object_key);
    expect(safeguards).not.toContain(published);
  });

  it('partitions a backlog between two workers without either finalizing the other job', async () => {
    const seeded = await Promise.all([
      seedQueuedJob(),
      seedQueuedJob(),
      seedQueuedJob(),
      seedQueuedJob(),
    ]);
    const first = startWorker();
    const second = startWorker();
    await Promise.all([waitForWorkerReady(first), waitForWorkerReady(second)]);

    await waitFor(
      async () =>
        (await countJobsWithStatus(ExportJobStatus.Completed)) ===
        seeded.length,
      120_000,
    );

    // Both processes did work, which is what makes the partition assertion mean
    // something rather than describe one worker that happened to be fast.
    const byFirst = completionsLoggedBy(first);
    const bySecond = completionsLoggedBy(second);
    expect(byFirst + bySecond).toBe(seeded.length);
    expect(byFirst).toBeGreaterThan(0);
    expect(bySecond).toBeGreaterThan(0);

    // Distinct claim tokens across the two processes: every object key carries the
    // token of the attempt that wrote it, so four distinct keys is four distinct
    // claims, and no job was finalized by an attempt that did not own it.
    const keys = await completedObjectKeys();
    expect(new Set(keys).size).toBe(seeded.length);
  });

  it('drains in flight work on SIGTERM rather than abandoning it', async () => {
    const { jobId } = await seedQueuedJob();
    const worker = startWorker();
    await waitForWorkerReady(worker);
    await waitFor(
      () =>
        Promise.resolve(
          workerOutput.get(worker)?.includes('room_export_generated') ?? false,
        ),
      60_000,
    );

    worker.kill('SIGTERM');
    const code = await waitForExit(worker, 120_000);

    // A clean drain: the process reports it finished and exits zero, and the export it
    // was holding is complete rather than left for a lease to recover.
    expect(workerOutput.get(worker)).toContain('"drained":true');
    expect(code).toBe(0);
    expect((await readJob(jobId)).status).toBe(ExportJobStatus.Completed);
  });

  it('samples a backlog an operator can read', async () => {
    await seedQueuedJob();
    const worker = startWorker();
    await waitForWorkerReady(worker);

    await waitFor(
      () =>
        Promise.resolve(
          workerOutput.get(worker)?.includes('room_export_backlog_sampled') ??
            false,
        ),
      60_000,
    );

    const sample = lastBacklogSample(worker);
    expect(sample).toBeDefined();
    // The five readings the runbook tells an operator to read.
    expect(sample).toHaveProperty('outbox');
    expect(sample).toHaveProperty('leases');
    expect(sample).toHaveProperty('jobs');
    expect(sample).toHaveProperty('failures');
    expect(sample).toHaveProperty('safeguards');
    // And nothing that would leak: no object key, no filters, no room values.
    const serialized = JSON.stringify(sample);
    expect(serialized).not.toContain('exports/rooms');
    expect(serialized).not.toContain('A-0');
  });

  function startWorker(overrides: NodeJS.ProcessEnv = {}): ChildProcess {
    const child = spawn('node', ['dist/worker'], {
      cwd: process.cwd(),
      env: { ...baseEnvironment, ...overrides },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.add(child);
    workerOutput.set(child, '');
    child.stdout?.on('data', (chunk: Buffer) => {
      workerOutput.set(
        child,
        (workerOutput.get(child) ?? '') + chunk.toString('utf8'),
      );
    });
    return child;
  }

  /** How many exports this specific process finished, read from its own log. */
  function completionsLoggedBy(child: ChildProcess): number {
    return (
      (workerOutput.get(child) ?? '').split('room_export_completed').length - 1
    );
  }

  function lastBacklogSample(child: ChildProcess): unknown {
    const lines = (workerOutput.get(child) ?? '')
      .split('\n')
      .filter((line) => line.includes('room_export_backlog_sampled'));
    const last = lines[lines.length - 1];
    if (!last) return undefined;
    const parsed = JSON.parse(last) as { message?: unknown };
    return parsed.message;
  }

  /**
   * Spawning is not readiness. The difference is the whole of the contention these
   * tests try to observe, so they wait for the process to say it has started.
   */
  async function waitForWorkerReady(
    child: ChildProcess,
    timeoutMs = 60_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (
        (workerOutput.get(child) ?? '').includes('notification_worker_started')
      ) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(
          `worker exited before starting, code ${String(child.exitCode)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error('worker did not report that it started');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  function waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('worker did not exit within the drain bound')),
        timeoutMs,
      );
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
  }

  async function waitFor(
    condition: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() >= deadline)
        throw new Error('condition was not met in time');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function seedQueuedJob(): Promise<{ jobId: string; eventId: string }> {
    const jobId = randomUUID();
    const eventId = randomUUID();
    await dataSource.query(
      `INSERT INTO outbox_events (id, event_type, payload, available_at, status, idempotency_key)
       VALUES (?, ?, JSON_OBJECT('schemaVersion', 1, 'jobId', ?), NOW(6), 'PENDING', ?)`,
      [eventId, roomExportEventType, jobId, `${roomExportEventType}:${jobId}`],
    );
    await dataSource.query(
      `INSERT INTO export_jobs (id, requested_by, outbox_event_id, status, filters)
       VALUES (?, ?, ?, ?, JSON_OBJECT())`,
      [jobId, adminId, eventId, ExportJobStatus.Queued],
    );
    return { jobId, eventId };
  }

  async function insertRoomType(): Promise<string> {
    const result: { insertId: number } = await dataSource.query(
      'INSERT INTO room_types (name, description) VALUES (?, ?)',
      [`Deluxe ${randomUUID().slice(0, 8)}`, 'Rooms'],
    );
    return String(result.insertId);
  }

  async function insertRoom(
    roomTypeId: string,
    roomNumber: string,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO rooms
         (room_type_id, room_number, bed_count, view_code, base_price_amount, currency, status)
       VALUES (?, ?, 2, 'CITY', 1500000, 'VND', ?)`,
      [roomTypeId, roomNumber, RoomStatus.Active],
    );
  }

  async function readJob(id: string): Promise<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      'SELECT * FROM export_jobs WHERE id = ?',
      [id],
    );
    return rows[0];
  }

  async function readEvent(id: string): Promise<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      'SELECT * FROM outbox_events WHERE id = ?',
      [id],
    );
    return rows[0];
  }

  async function countJobsWithStatus(status: ExportJobStatus): Promise<number> {
    const rows: Array<{ total: string }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM export_jobs WHERE status = ?',
      [status],
    );
    return Number(rows[0].total);
  }

  async function completedObjectKeys(): Promise<string[]> {
    const rows: Array<{ object_key: string }> = await dataSource.query(
      'SELECT object_key FROM export_jobs WHERE object_key IS NOT NULL',
    );
    return rows.map((row) => row.object_key);
  }

  async function readSafeguards(): Promise<Array<{ object_key: string }>> {
    return dataSource.query(
      "SELECT object_key FROM storage_cleanup_tasks WHERE reason = 'UPLOAD_SAFEGUARD'",
    );
  }

  async function countSafeguards(): Promise<number> {
    return (await readSafeguards()).length;
  }

  async function obliterateQueue(): Promise<void> {
    const environment = validateEnvironment(process.env);
    const client = new Redis({
      host: environment.REDIS_HOST,
      port: environment.REDIS_PORT,
      maxRetriesPerRequest: null,
    });
    try {
      const keys = await client.keys(`${queuePrefix}*`);
      if (keys.length > 0) await client.del(...keys);
    } finally {
      await client.quit();
    }
  }
});
