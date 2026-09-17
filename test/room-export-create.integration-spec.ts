import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { IdempotencyKeyStatus } from '../src/bookings/entities/booking.enums';
import { IdempotencyRepository } from '../src/common/idempotency/idempotency.repository';
import { createBookingsConfiguration } from '../src/config/bookings.config';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createReportsConfiguration } from '../src/config/reports.config';
import { applicationEntities } from '../src/database/application-entities';
import { createTypeOrmOptions } from '../src/database/database.options';
import { ExportJobStatus } from '../src/reports/entities/export-job.enums';
import { ExportJobRepository } from '../src/reports/export-job.repository';
import { roomExportEventType } from '../src/reports/room-export.constants';
import { RoomExportService } from '../src/reports/room-export.service';
import type { RoomExportFilters } from '../src/reports/room-export.types';
import { RoomStatus } from '../src/rooms/entities/room.enums';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(60_000);

describe('Phase 6 export create transaction', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let service: RoomExportService;
  let adminId: string;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p6_t03_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Export create prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities: applicationEntities,
          migrations: applicationMigrations,
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    service = new RoomExportService(
      dataSource,
      new IdempotencyRepository(),
      new ExportJobRepository(),
      createReportsConfiguration({
        ...environment,
        REPORT_EXPORT_ENABLED: true,
      }),
      createBookingsConfiguration(environment),
    );
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM export_jobs');
    await dataSource.query('DELETE FROM idempotency_keys');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM users');
    const inserted: { insertId: number } = await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Export Admin', 'ADMIN', 'ACTIVE', NOW(6))`,
      [`export-admin-${randomUUID()}@hotel.test`],
    );
    adminId = String(inserted.insertId);
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

  it('commits the job, the outbox event, and the stored response together', async () => {
    const response = await create('key-commits-together', { beds: 2 });

    expect(Object.keys(response).sort()).toEqual([
      'createdAt',
      'id',
      'pollPath',
      'status',
    ]);
    expect(response.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.status).toBe(ExportJobStatus.Queued);
    expect(response.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.pollPath).toBe(`/api/v1/admin/exports/${response.id}`);

    const job = await readJob(response.id);
    expect(job.status).toBe(ExportJobStatus.Queued);
    expect(job.requested_by).toBe(adminId);
    expect(job.filters).toEqual({ beds: 2 });
    // Queued means queued: no result, no failure, nothing for a poll to hand out.
    expect(job.object_key).toBeNull();
    expect(job.expires_at).toBeNull();

    const event = await readEvent(job.outbox_event_id);
    expect(event.event_type).toBe(roomExportEventType);
    expect(event.status).toBe('PENDING');
    // Minimal and versioned. A consumer that could act on the payload alone would be
    // acting on data the durable row may already have superseded.
    expect(event.payload).toEqual({
      schemaVersion: 1,
      jobId: response.id,
    });

    const stored = await readIdempotency('key-commits-together');
    expect(stored.status).toBe(IdempotencyKeyStatus.Completed);
    expect(stored.response_status).toBe(202);
    expect(stored.response_body).toEqual(response);
  });

  it('replays the stored response byte for byte', async () => {
    const first = await create('key-replays', { status: RoomStatus.Active });
    const second = await create('key-replays', { status: RoomStatus.Active });

    expect(second).toEqual(first);
    expect(await countRows('export_jobs')).toBe(1);
    expect(await countRows('outbox_events')).toBe(1);
  });

  it('replays a request whose filters normalize to the same thing', async () => {
    // A client that sends the same filters in a different key order, or with a term
    // that only differs by surrounding whitespace, has sent the same request.
    const first = await create('key-normalized', { query: 'A-2', beds: 2 });
    const second = await create('key-normalized', { beds: 2, query: 'A-2' });

    expect(second).toEqual(first);
    expect(await countRows('export_jobs')).toBe(1);
  });

  it('refuses the same key for a different request', async () => {
    await create('key-reused', { beds: 2 });

    await expect(create('key-reused', { beds: 3 })).rejects.toMatchObject({
      errorCode: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await countRows('export_jobs')).toBe(1);
  });

  it('creates exactly one job under concurrent identical calls', async () => {
    // The insert-then-lock order is what makes this deterministic: both callers find
    // a row to lock rather than racing to create one, and the loser replays.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create('key-concurrent', { beds: 2 })),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await countRows('export_jobs')).toBe(1);
    expect(await countRows('outbox_events')).toBe(1);
    expect(await countRows('idempotency_keys')).toBe(1);
  });

  it('separates concurrent calls that carry different keys', async () => {
    const results = await Promise.all([
      create('key-parallel-a', { beds: 2 }),
      create('key-parallel-b', { beds: 3 }),
    ]);

    expect(new Set(results.map((result) => result.id)).size).toBe(2);
    expect(await countRows('export_jobs')).toBe(2);
    expect(await countRows('outbox_events')).toBe(2);
  });

  it('leaves nothing behind when the transaction fails', async () => {
    // A requester that no longer exists fails the job's restrictive foreign key, which
    // is the last write in the transaction. If the idempotency row or the outbox event
    // survived that rollback, a retry would replay a response for a job nobody created.
    await dataSource.query('DELETE FROM users WHERE id = ?', [adminId]);

    await expect(create('key-rolls-back', { beds: 2 })).rejects.toThrow();

    expect(await countRows('export_jobs')).toBe(0);
    expect(await countRows('outbox_events')).toBe(0);
    expect(await countRows('idempotency_keys')).toBe(0);
  });

  function create(idempotencyKey: string, filters: RoomExportFilters) {
    return service.create({
      actorUserId: adminId,
      idempotencyKey: `room-export-${idempotencyKey}`,
      filters,
    });
  }

  async function readJob(id: string): Promise<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      'SELECT * FROM export_jobs WHERE id = ?',
      [id],
    );
    return rows[0];
  }

  async function readEvent(id: unknown): Promise<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      'SELECT * FROM outbox_events WHERE id = ?',
      [id],
    );
    return rows[0];
  }

  async function readIdempotency(
    key: string,
  ): Promise<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = await dataSource.query(
      'SELECT * FROM idempotency_keys WHERE idempotency_key = ?',
      [`room-export-${key}`],
    );
    return rows[0];
  }

  async function countRows(table: string): Promise<number> {
    const rows: Array<{ total: string | number }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM ${table}`,
    );
    return Number(rows[0].total);
  }
});
