import { randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import { createObjectStorageClientOptions } from '../src/common/storage/object-storage-client';
import { ObjectStorageProvider } from '../src/common/storage/object-storage.provider';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createObjectStorageConfiguration } from '../src/config/object-storage.config';
import {
  createReportsConfiguration,
  type ReportsConfiguration,
} from '../src/config/reports.config';
import { reportsWorkerEntities } from '../src/reports/reports-worker.entities';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { createTypeOrmOptions } from '../src/database/database.options';
import { ExportJobStatus } from '../src/reports/entities/export-job.enums';
import { RoomExportAttemptRepository } from '../src/reports/room-export-attempt.repository';
import { RoomExportConsumerService } from '../src/reports/room-export-consumer.service';
import { RoomExportGeneratorService } from '../src/reports/room-export-generator.service';
import { RoomExportSnapshotRepository } from '../src/reports/room-export-snapshot.repository';
import { RoomExportStorageService } from '../src/reports/room-export-storage.service';
import { RoomExportViewRepository } from '../src/reports/room-export-view.repository';
import { RoomExportViewService } from '../src/reports/room-export-view.service';
import { roomExportEventType } from '../src/reports/room-export.constants';
import { RoomStatus } from '../src/rooms/entities/room.enums';
import { applicationMigrations } from './fixtures/application-migrations';
import { ensureAttachmentBucket } from './fixtures/room-images';

jest.setTimeout(120_000);

/**
 * Hooks as subclasses rather than spies on private fields.
 *
 * Each of these runs a callback at the exact moment the attempt reaches a boundary -
 * the Worker Thread, the upload, the finalize - and then does the real thing. The
 * consumer keeps its real collaborators, so what is under test is the sequence the
 * production path runs rather than a rearranged one.
 */
class ProbingGenerator extends RoomExportGeneratorService {
  constructor(
    configuration: ReportsConfiguration,
    private readonly before: () => Promise<void>,
  ) {
    super(configuration);
  }

  override async generate(
    command: Parameters<RoomExportGeneratorService['generate']>[0],
  ): ReturnType<RoomExportGeneratorService['generate']> {
    await this.before();
    return super.generate(command);
  }
}

class ProbingStorage extends RoomExportStorageService {
  constructor(
    provider: ObjectStorageProvider,
    configuration: ReportsConfiguration,
    private readonly before: () => Promise<void>,
    private readonly failWith?: Error,
  ) {
    super(provider, configuration);
  }

  override async upload(
    upload: Parameters<RoomExportStorageService['upload']>[0],
  ): Promise<void> {
    await this.before();
    if (this.failWith) throw this.failWith;
    return super.upload(upload);
  }
}

class ProbingAttempts extends RoomExportAttemptRepository {
  constructor(private readonly beforeComplete: () => Promise<void>) {
    super();
  }

  override async complete(
    manager: Parameters<RoomExportAttemptRepository['complete']>[0],
    input: Parameters<RoomExportAttemptRepository['complete']>[1],
  ): Promise<boolean> {
    await this.beforeComplete();
    return super.complete(manager, input);
  }
}

describe('Phase 6 room export attempt', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let s3: S3Client;
  // One provider for the whole suite, over the one client `afterAll` destroys. Built
  // per helper call it would leave an HTTP agent and its sockets open on every case,
  // which is what keeps a Jest run alive after the last assertion.
  let objectStorage: ObjectStorageProvider;
  let bucket: string;
  let adminId: string;
  let probe: mysql.Connection;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p6_t05_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Export attempt prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const storage = createObjectStorageConfiguration(environment);
    bucket = storage.bucket;
    s3 = new S3Client(createObjectStorageClientOptions(storage));
    objectStorage = new ObjectStorageProvider(s3, storage);
    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          // Exactly what `ReportsWorkerModule` registers, not every entity in the
          // application: a suite that registers more cannot notice one the worker is
          // missing, which is how `Room` reached production unregistered.
          entities: reportsWorkerEntities,
          migrations: applicationMigrations,
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    probe = await mysql.createConnection({
      host: environment.MYSQL_HOST,
      port: environment.MYSQL_PORT,
      user: environment.MYSQL_USER,
      password: environment.MYSQL_PASSWORD,
      database: disposableDatabase,
    });
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
    for (let index = 0; index < 3; index += 1) {
      await insertRoom(typeId, `A-${index}`);
    }
  });

  afterAll(async () => {
    if (probe) await probe.end();
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

  it('completes one attempt: object stored, job published, safeguard removed', async () => {
    const claimed = await seedClaimedJob();

    const outcome = await consumer().process(claimed.job);

    expect(outcome).toEqual({ result: 'completed' });
    const job = await readJob(claimed.jobId);
    expect(job.status).toBe(ExportJobStatus.Completed);
    expect(Number(job.row_count)).toBe(3);
    expect(Number(job.file_size_bytes)).toBeGreaterThan(0);
    expect(job.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(job.expires_at).toBeInstanceOf(Date);
    // The key is the attempt's own, built from the job and the claim token only.
    expect(job.object_key).toBe(
      `exports/rooms/${claimed.jobId}/${claimed.job.claimToken}.xlsx`,
    );

    const event = await readEvent(claimed.outboxEventId);
    expect(event.status).toBe(OutboxEventStatus.Processed);
    expect(event.locked_by).toBeNull();

    // The object exists and its bytes are the ones the job recorded.
    const stored = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: String(job.object_key) }),
    );
    expect(Number(stored.ContentLength)).toBe(Number(job.file_size_bytes));

    // The winning attempt removed its own safeguard, so cleanup will not delete the
    // object the job now points at.
    expect(await countSafeguards()).toBe(0);
  });

  it('hands the requester a signed URL that actually downloads the workbook', async () => {
    const claimed = await seedClaimedJob();
    await consumer().process(claimed.job);

    const view = await viewService().getOwned(claimed.jobId, adminId);

    expect(view.status).toBe('COMPLETED');
    expect(view.rowCount).toBe(3);
    expect(view.download).toBeDefined();
    // The URL is the only way in: the bucket is private, so the same object without a
    // signature must be refused.
    const signed = view.download?.url ?? '';
    const response = await fetch(signed);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers.get('content-disposition')).toContain(
      `rooms-export-${claimed.jobId}.xlsx`,
    );
    const body = Buffer.from(await response.arrayBuffer());
    // A real XLSX is a ZIP; `PK` is its signature.
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(body.byteLength).toBe(view.fileSizeBytes);

    const unsigned = await fetch(signed.split('?')[0]);
    expect(unsigned.status).toBe(403);

    // The key is never a field of its own. It does appear inside the signed URL,
    // because an S3 presigned URL is a signature over a path - there is no way to sign
    // a read of an object without naming it. What the contract forbids is returning the
    // key as data a client could reuse, and putting it in logs or queue payloads.
    expect(view).not.toHaveProperty('objectKey');
    const withoutDownload = { ...view, download: undefined };
    expect(JSON.stringify(withoutDownload)).not.toContain('exports/rooms');
  });

  it('caps the URL at what remains of the result, and refuses once it lapses', async () => {
    const claimed = await seedClaimedJob();
    await consumer().process(claimed.job);

    // Thirty seconds left against a five-minute configured lifetime.
    await dataSource.query(
      'UPDATE export_jobs SET expires_at = NOW(6) + INTERVAL 30 SECOND WHERE id = ?',
      [claimed.jobId],
    );
    const nearExpiry = await viewService().getOwned(claimed.jobId, adminId);
    const expiresAt = new Date(nearExpiry.download?.expiresAt ?? 0).getTime();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(31_000);

    // Past its expiry: the metadata survives so the requester can see what happened,
    // and the one field that would still have worked is gone.
    await dataSource.query(
      'UPDATE export_jobs SET expires_at = NOW(6) - INTERVAL 1 SECOND WHERE id = ?',
      [claimed.jobId],
    );
    const expired = await viewService().getOwned(claimed.jobId, adminId);
    expect(expired.status).toBe('EXPIRED');
    expect(expired.download).toBeUndefined();
    expect(expired.rowCount).toBe(3);
  });

  it('does nothing for a duplicate job whose claim has moved on', async () => {
    const claimed = await seedClaimedJob();
    // Another dispatcher recovered the lease and issued a new token.
    await dataSource.query(
      'UPDATE outbox_events SET locked_by = ?, attempts = attempts + 1 WHERE id = ?',
      ['token-somebody-else', claimed.outboxEventId],
    );

    expect(await consumer().process(claimed.job)).toEqual({
      result: 'skipped',
      errorCode: 'EXPORT_CLAIM_LOST',
    });
    expect((await readJob(claimed.jobId)).status).toBe(ExportJobStatus.Queued);
    expect(await countSafeguards()).toBe(0);
  });

  it('leaves the object covered when the claim is lost after the upload', async () => {
    const claimed = await seedClaimedJob();
    // The lease is recovered between the upload and the finalize, which is the window
    // the staging key and the safeguard exist for.
    const service = consumer({
      beforeComplete: async () => {
        await dataSource.query(
          'UPDATE outbox_events SET locked_by = ? WHERE id = ?',
          ['token-recovered', claimed.outboxEventId],
        );
      },
    });

    expect(await service.process(claimed.job)).toEqual({
      result: 'skipped',
      errorCode: 'EXPORT_CLAIM_LOST',
    });

    const job = await readJob(claimed.jobId);
    // Nothing points at the uploaded bytes.
    expect(job.status).toBe(ExportJobStatus.Processing);
    expect(job.object_key).toBeNull();
    // And the safeguard that covers them is still there for the cleanup runner.
    const safeguards = await readSafeguards();
    expect(safeguards).toHaveLength(1);
    expect(safeguards[0].object_key).toBe(
      `exports/rooms/${claimed.jobId}/${claimed.job.claimToken}.xlsx`,
    );
  });

  it('gives a stale attempt a key of its own, so it cannot overwrite the winner', async () => {
    const winner = await seedClaimedJob();
    await consumer().process(winner.job);
    const publishedKey = String((await readJob(winner.jobId)).object_key);

    // A second attempt on the same job, with its own token - the shape a recovered
    // lease produces. It cannot finalize, and its key is not the published one.
    const staleToken = randomUUID();
    await dataSource.query(
      `UPDATE outbox_events SET status = ?, locked_by = ?, locked_at = NOW(6),
         lock_expires_at = NOW(6) + INTERVAL 5 MINUTE, attempts = 2, processed_at = NULL
       WHERE id = ?`,
      [OutboxEventStatus.Processing, staleToken, winner.outboxEventId],
    );

    const outcome = await consumer().process({
      outboxEventId: winner.outboxEventId,
      claimToken: staleToken,
      attempt: 2,
    });

    // The job is COMPLETED, so the claim query refuses it before any work begins.
    expect(outcome.result).toBe('skipped');
    expect(String((await readJob(winner.jobId)).object_key)).toBe(publishedKey);
  });

  it('retries a transient failure and keeps the attempt budget', async () => {
    const claimed = await seedClaimedJob();
    const service = consumer({
      uploadFails: Object.assign(new Error('provider refused'), {
        name: 'ServiceUnavailable',
      }),
    });

    expect(await service.process(claimed.job)).toMatchObject({
      result: 'retried',
    });

    const job = await readJob(claimed.jobId);
    expect(job.status).toBe(ExportJobStatus.Queued);
    expect(job.last_error_code).toBe('EXPORT_ATTEMPT_FAILED');
    const event = await readEvent(claimed.outboxEventId);
    expect(event.status).toBe(OutboxEventStatus.Pending);
    // Scheduled into the future by the database, not by this process's clock.
    expect(new Date(String(event.available_at)).getTime()).toBeGreaterThan(
      Date.now(),
    );
    // The safeguard for the abandoned upload attempt survives for cleanup.
    expect(await countSafeguards()).toBe(1);
  });

  it('fails terminally once the attempt budget is spent', async () => {
    const claimed = await seedClaimedJob({ attempt: 3 });
    const service = consumer({ uploadFails: new Error('provider refused') });

    expect(await service.process(claimed.job)).toMatchObject({
      result: 'failed',
    });

    const job = await readJob(claimed.jobId);
    expect(job.status).toBe(ExportJobStatus.Failed);
    expect(job.failed_at).toBeInstanceOf(Date);
    expect(job.object_key).toBeNull();
    expect(await readEvent(claimed.outboxEventId)).toMatchObject({
      status: OutboxEventStatus.Failed,
    });
  });

  it('fails a permanent error immediately, with budget remaining', async () => {
    // A snapshot past the row cap will never fit on a later attempt: the filters would
    // have to change, and only the administrator can do that.
    const claimed = await seedClaimedJob();
    const service = consumer({
      mutate: (draft) => {
        draft.snapshot.maxRows = 1;
      },
    });

    expect(await service.process(claimed.job)).toEqual({
      result: 'failed',
      errorCode: 'EXPORT_ROW_LIMIT_EXCEEDED',
    });

    const job = await readJob(claimed.jobId);
    expect(job.status).toBe(ExportJobStatus.Failed);
    expect(job.last_error_code).toBe('EXPORT_ROW_LIMIT_EXCEEDED');
    // Nothing was uploaded, so nothing needs covering.
    expect(await countSafeguards()).toBe(0);
  });

  it('holds no database transaction while the Worker Thread and the upload run', async () => {
    // The claim is held by a lease, not by a lock. A transaction open across a
    // 60-second generation and a 25 MiB upload would hold a pooled connection for the
    // whole attempt, and the pool is the real cap on concurrent traffic.
    const claimed = await seedClaimedJob();
    const observed: boolean[] = [];
    // A lock-timeout probe rather than a transaction count: `information_schema
    // .innodb_trx` needs the PROCESS privilege the application user deliberately does
    // not have, and this asks the question that actually matters anyway - can another
    // transaction take the rows this attempt is working on?
    const sample = async () => {
      await probe.query('SET innodb_lock_wait_timeout = 2');
      await probe.query('START TRANSACTION');
      try {
        await probe.query(
          'SELECT id FROM outbox_events WHERE id = ? FOR UPDATE',
          [claimed.outboxEventId],
        );
        await probe.query(
          'SELECT id FROM export_jobs WHERE id = ? FOR UPDATE',
          [claimed.jobId],
        );
        observed.push(true);
      } catch {
        observed.push(false);
      } finally {
        await probe.query('ROLLBACK');
      }
    };
    const service = consumer({ beforeGenerate: sample, beforeUpload: sample });

    expect(await service.process(claimed.job)).toEqual({ result: 'completed' });

    // Both stages: the rows were free to lock, so nothing held them while a Worker
    // Thread built a workbook and an object store accepted it.
    expect(observed).toEqual([true, true]);
  });

  function viewService(): RoomExportViewService {
    const environment = validateEnvironment(process.env);
    const configuration = createReportsConfiguration({
      ...environment,
      REPORT_EXPORT_ENABLED: true,
    });
    return new RoomExportViewService(
      new RoomExportViewRepository(dataSource),
      new RoomExportStorageService(objectStorage, configuration),
      configuration,
    );
  }

  interface ConsumerProbes {
    mutate?: (draft: ReportsConfiguration) => void;
    beforeGenerate?: () => Promise<void>;
    beforeUpload?: () => Promise<void>;
    beforeComplete?: () => Promise<void>;
    uploadFails?: Error;
  }

  function consumer(probes: ConsumerProbes = {}): RoomExportConsumerService {
    const environment = validateEnvironment(process.env);
    const configuration = createReportsConfiguration({
      ...environment,
      REPORT_EXPORT_ENABLED: true,
    });
    probes.mutate?.(configuration);
    const noop = () => Promise.resolve();
    return new RoomExportConsumerService(
      new DatabaseConnectionService(dataSource),
      new ProbingAttempts(probes.beforeComplete ?? noop),
      new RoomExportSnapshotRepository(dataSource, configuration),
      new ProbingGenerator(configuration, probes.beforeGenerate ?? noop),
      new ProbingStorage(
        objectStorage,
        configuration,
        probes.beforeUpload ?? noop,
        probes.uploadFails,
      ),
      // No consumer connection: these cases drive `process` directly rather than
      // through BullMQ, which the dispatch suite exercises.
      null,
      configuration,
    );
  }

  async function seedClaimedJob(options: { attempt?: number } = {}): Promise<{
    jobId: string;
    outboxEventId: string;
    job: { outboxEventId: string; claimToken: string; attempt: number };
  }> {
    const attempt = options.attempt ?? 1;
    const claimToken = randomUUID();
    const outboxEventId = randomUUID();
    const jobId = randomUUID();
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key,
          locked_at, lock_expires_at, locked_by, attempts)
       VALUES (?, ?, JSON_OBJECT('schemaVersion', 1, 'jobId', ?), NOW(6), ?, ?,
               NOW(6), NOW(6) + INTERVAL 5 MINUTE, ?, ?)`,
      [
        outboxEventId,
        roomExportEventType,
        jobId,
        OutboxEventStatus.Processing,
        `${roomExportEventType}:${jobId}`,
        claimToken,
        attempt,
      ],
    );
    await dataSource.query(
      `INSERT INTO export_jobs (id, requested_by, outbox_event_id, status, filters)
       VALUES (?, ?, ?, ?, JSON_OBJECT())`,
      [jobId, adminId, outboxEventId, ExportJobStatus.Queued],
    );
    return {
      jobId,
      outboxEventId,
      job: { outboxEventId, claimToken, attempt },
    };
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

  async function readSafeguards(): Promise<Array<Record<string, unknown>>> {
    return dataSource.query(
      "SELECT * FROM storage_cleanup_tasks WHERE reason = 'UPLOAD_SAFEGUARD'",
    );
  }

  async function countSafeguards(): Promise<number> {
    return (await readSafeguards()).length;
  }
});
