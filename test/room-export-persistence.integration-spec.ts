import { randomUUID } from 'node:crypto';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { claimBatchIsolation } from '../src/common/outbox/outbox-claim.constants';
import { OutboxClaimRepository } from '../src/common/outbox/outbox-claim.repository';
import { notificationEventTypes } from '../src/notifications/notification-event';
import { NotificationBacklogRepository } from '../src/notifications/notification-backlog.repository';
import { roomExportEventTypes } from '../src/reports/room-export.constants';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(60_000);

const exportEventType = roomExportEventTypes[0];
const mailEventType = notificationEventTypes[0];

describe('Phase 6 export persistence and event-family isolation', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let claims: OutboxClaimRepository;
  let requesterId: string;

  beforeEach(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p6_t02_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Export persistence prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
    claims = new OutboxClaimRepository();
    requesterId = await insertAdmin();
  });

  afterEach(async () => {
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
    it('applies onto a Phase 5 database and reverts before any job exists', async () => {
      expect(await tableExists('export_jobs')).toBe(true);
      expect(
        await indexExists('outbox_events', 'idx_outbox_events_claim_by_type'),
      ).toBe(true);
      // Phase 5 is untouched: the migration is additive, which is what lets it be
      // deployed ahead of the code that reads it.
      expect(await tableExists('email_deliveries')).toBe(true);
      expect(
        await indexExists('outbox_events', 'idx_outbox_events_claim'),
      ).toBe(true);

      await dataSource.undoLastMigration();
      expect(await tableExists('export_jobs')).toBe(false);
      expect(
        await indexExists('outbox_events', 'idx_outbox_events_claim_by_type'),
      ).toBe(false);
      expect(await tableExists('email_deliveries')).toBe(true);

      await dataSource.runMigrations();
      expect(await tableExists('export_jobs')).toBe(true);
      expect(
        await indexExists('outbox_events', 'idx_outbox_events_claim_by_type'),
      ).toBe(true);
    });

    it('accepts every valid lifecycle row shape', async () => {
      for (const status of ['QUEUED', 'PROCESSING']) {
        await expect(insertJob({ status })).resolves.toBeDefined();
      }
      await expect(insertJob(completedShape())).resolves.toBeDefined();
      await expect(insertJob(failedShape())).resolves.toBeDefined();
    });

    it('refuses a half-written completion or a failure carrying a result', async () => {
      // Each of these is a row a careful service would not write and a partially
      // applied one might. The last is the one that matters most: a COMPLETED job
      // without an object key is a download URL for something never uploaded.
      const invalid: Array<Record<string, unknown>> = [
        { ...completedShape(), object_key: null },
        { ...completedShape(), row_count: null },
        { ...completedShape(), file_size_bytes: null },
        { ...completedShape(), content_sha256: null },
        { ...completedShape(), started_at: null },
        { ...completedShape(), expires_at: null },
        { ...completedShape(), failed_at: new Date() },
        { ...completedShape(), last_error_code: 'EXPORT_GENERATION_FAILED' },
        { ...failedShape(), last_error_code: null },
        { ...failedShape(), object_key: 'exports/rooms/leaked.xlsx' },
        { ...failedShape(), row_count: 10 },
        { status: 'QUEUED', object_key: 'exports/rooms/early.xlsx' },
        { status: 'PROCESSING', completed_at: new Date() },
      ];

      for (const shape of invalid) {
        await expect(insertJob(shape)).rejects.toThrow(
          /chk_export_jobs_state_shape/,
        );
      }
    });

    it('refuses a completion that finished before it started', async () => {
      const started = new Date(Date.UTC(2026, 8, 17, 8, 0, 1));
      await expect(
        insertJob({
          ...completedShape(),
          started_at: started,
          completed_at: new Date(started.getTime() - 1_000),
        }),
      ).rejects.toThrow(/chk_export_jobs_started_before_completed/);
    });

    it('keeps result counts inside the range the API can represent', async () => {
      // 2^53 - 1. A larger value is one MySQL accepts and JSON rounds, so an
      // administrator would read a different number than the one stored.
      await expect(
        insertJob({ ...completedShape(), row_count: '9007199254740991' }),
      ).resolves.toBeDefined();
      await expect(
        insertJob({ ...completedShape(), row_count: '9007199254740992' }),
      ).rejects.toThrow(/chk_export_jobs_result_bounds/);
      await expect(
        insertJob({ ...completedShape(), file_size_bytes: '9007199254740992' }),
      ).rejects.toThrow(/chk_export_jobs_result_bounds/);
    });

    it('allows one job per outbox event and no more', async () => {
      const outboxEventId = await insertEvent(exportEventType);
      await insertJob({ status: 'QUEUED' }, outboxEventId);

      await expect(
        insertJob({ status: 'QUEUED' }, outboxEventId),
      ).rejects.toThrow(/uq_export_jobs_outbox_event/);
    });

    it('refuses to delete a requester or trigger a job still references', async () => {
      const outboxEventId = await insertEvent(exportEventType);
      await insertJob({ status: 'QUEUED' }, outboxEventId);

      await expect(
        dataSource.query('DELETE FROM outbox_events WHERE id = ?', [
          outboxEventId,
        ]),
      ).rejects.toThrow(/fk_export_jobs_outbox_event/);
      await expect(
        dataSource.query('DELETE FROM users WHERE id = ?', [requesterId]),
      ).rejects.toThrow(/fk_export_jobs_requested_by/);
    });

    it('compares object keys and hashes as bytes', async () => {
      // An object key differing only in case is a different object in the bucket, so
      // a case-insensitive column would let one job's key match another's row.
      const columns: Array<[string, string]> = [
        ['id', 'ascii_bin'],
        ['outbox_event_id', 'ascii_bin'],
        ['object_key', 'ascii_bin'],
        ['content_sha256', 'ascii_bin'],
        ['last_error_code', 'ascii_bin'],
      ];
      for (const [column, collation] of columns) {
        expect(await collationOf('export_jobs', column)).toBe(collation);
      }
    });

    it('carries the ownership and operations access paths', async () => {
      expect(
        await indexColumns('export_jobs', 'idx_export_jobs_owner'),
      ).toEqual(['requested_by', 'created_at', 'id']);
      expect(
        await indexColumns('export_jobs', 'idx_export_jobs_operations'),
      ).toEqual(['status', 'updated_at', 'id']);
      expect(
        await indexColumns('outbox_events', 'idx_outbox_events_claim_by_type'),
      ).toEqual(['event_type', 'status', 'available_at', 'lock_expires_at']);
    });
  });

  describe('event-family isolation', () => {
    it('lets two dispatchers claim concurrently without seeing each other rows', async () => {
      const mail = await insertEvent(mailEventType, minutesAgo(3));
      const exportEvent = await insertEvent(exportEventType, minutesAgo(2));

      const mailRunner = dataSource.createQueryRunner();
      await mailRunner.connect();
      await mailRunner.startTransaction(claimBatchIsolation);
      try {
        expect(
          await claims.claimBatch(mailRunner.manager, {
            eventTypes: notificationEventTypes,
            batchSize: 10,
            leaseMs: 120_000,
            claimToken: 'token-mail',
          }),
        ).toEqual([{ id: mail, attempt: 1 }]);

        // The export dispatcher runs while the mail claim is still open. Without the
        // allowlist in the claiming statement it would either lease the mail row or
        // wait behind it; with it, the two never meet.
        const exportRunner = dataSource.createQueryRunner();
        await exportRunner.connect();
        await exportRunner.startTransaction(claimBatchIsolation);
        try {
          await exportRunner.manager.query('SET innodb_lock_wait_timeout = 2');
          expect(
            await claims.claimBatch(exportRunner.manager, {
              eventTypes: roomExportEventTypes,
              batchSize: 10,
              leaseMs: 120_000,
              claimToken: 'token-export',
            }),
          ).toEqual([{ id: exportEvent, attempt: 1 }]);
          await exportRunner.commitTransaction();
        } finally {
          await exportRunner.release();
        }
        await mailRunner.commitTransaction();
      } finally {
        await mailRunner.release();
      }

      expect((await readEvent(mail)).locked_by).toBe('token-mail');
      expect((await readEvent(exportEvent)).locked_by).toBe('token-export');
    });

    it('recovers only its own expired leases', async () => {
      const stale = await insertEvent(mailEventType, minutesAgo(5));
      await expireLease(stale, 'token-crashed');

      expect(
        await dataSource.transaction(claimBatchIsolation, (manager) =>
          claims.claimBatch(manager, {
            eventTypes: roomExportEventTypes,
            batchSize: 10,
            leaseMs: 120_000,
            claimToken: 'token-export',
          }),
        ),
      ).toEqual([]);
      expect((await readEvent(stale)).locked_by).toBe('token-crashed');

      expect(
        await dataSource.transaction(claimBatchIsolation, (manager) =>
          claims.claimBatch(manager, {
            eventTypes: notificationEventTypes,
            batchSize: 10,
            leaseMs: 120_000,
            claimToken: 'token-mail',
          }),
        ),
      ).toEqual([{ id: stale, attempt: 2 }]);
    });

    it('refuses a release from the wrong family', async () => {
      const exportEvent = await insertEvent(exportEventType, minutesAgo(1));
      const [claim] = await dataSource.transaction(
        claimBatchIsolation,
        (manager) =>
          claims.claimBatch(manager, {
            eventTypes: roomExportEventTypes,
            batchSize: 1,
            leaseMs: 120_000,
            claimToken: 'token-export',
          }),
      );

      expect(
        await dataSource.transaction((manager) =>
          claims.release(manager, {
            eventTypes: notificationEventTypes,
            id: claim.id,
            claimToken: 'token-export',
            attempt: claim.attempt,
            retryInMs: 30_000,
            errorCode: 'NOTIFICATION_QUEUE_UNAVAILABLE',
          }),
        ),
      ).toBe(false);
      expect((await readEvent(exportEvent)).status).toBe(
        OutboxEventStatus.Processing,
      );
    });

    it('refuses an empty allowlist rather than claiming everything', async () => {
      await insertEvent(mailEventType, minutesAgo(1));

      await expect(
        dataSource.transaction(claimBatchIsolation, (manager) =>
          claims.claimBatch(manager, {
            eventTypes: [],
            batchSize: 10,
            leaseMs: 120_000,
            claimToken: 'token-empty',
          }),
        ),
      ).rejects.toThrow(/at least one event type/);
    });

    it('keeps export events out of the notification backlog sample', async () => {
      await insertEvent(mailEventType, minutesAgo(4));
      await insertEvent(exportEventType, minutesAgo(9));
      await insertEvent(exportEventType, minutesAgo(8));

      const snapshot = await new NotificationBacklogRepository().read(
        dataSource.manager,
      );

      expect(snapshot.outbox.map((entry) => entry.eventType)).toEqual([
        mailEventType,
      ]);
      // A stuck export must not drive the mail backlog age and page the wrong
      // on-call: the oldest row overall is nine minutes old, the oldest mail four.
      expect(snapshot.outbox[0].oldestAvailableAgeMs).toBeLessThan(5 * 60_000);
    });
  });

  describe('claim access paths', () => {
    it('serves a single-family claim from the event-type index and a four-family claim without a sort', async () => {
      // A skewed backlog: exports are a small minority of a mail-dominated table,
      // which is the shape that would make a scan-everything claim look fine in a
      // fixture and fail in production.
      for (let index = 0; index < 200; index += 1) {
        await insertEvent(
          index % 25 === 0 ? exportEventType : mailEventType,
          minutesAgo(1),
        );
      }
      await dataSource.query('ANALYZE TABLE outbox_events');

      const exportPlan = await explainClaim(roomExportEventTypes);
      expect(exportPlan.key).toBe('idx_outbox_events_claim_by_type');
      expect(exportPlan.Extra ?? '').not.toMatch(/filesort/i);

      const mailPlan = await explainClaim(notificationEventTypes);
      // The recorded outcome, not an assumption: whichever index the optimizer picks,
      // the claim must not sort, because a claim that sorts locks the whole backlog
      // before LIMIT applies and leaves SKIP LOCKED nothing to skip to.
      expect(mailPlan.Extra ?? '').not.toMatch(/filesort/i);
    });
  });

  async function explainClaim(
    eventTypes: readonly string[],
  ): Promise<Record<string, string | null>> {
    const placeholders = eventTypes.map(() => '?').join(', ');
    const rows: Array<Record<string, string | null>> = await dataSource.query(
      `EXPLAIN SELECT id, available_at, created_at
       FROM outbox_events
       WHERE event_type IN (${placeholders})
         AND status = ?
         AND available_at <= NOW(6)
       ORDER BY available_at ASC
       LIMIT 10`,
      [...eventTypes, OutboxEventStatus.Pending],
    );
    return rows[0];
  }

  async function insertAdmin(): Promise<string> {
    const result: { insertId: number } = await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Export Owner', 'ADMIN', 'ACTIVE', NOW(6))`,
      [`export-owner-${randomUUID()}@hotel.test`],
    );
    return String(result.insertId);
  }

  async function insertEvent(
    eventType: string,
    availableAt: Date = new Date(),
  ): Promise<string> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO outbox_events (id, event_type, payload, available_at, status, idempotency_key)
       VALUES (?, ?, JSON_OBJECT('schemaVersion', 1), ?, ?, ?)`,
      [id, eventType, availableAt, OutboxEventStatus.Pending, randomUUID()],
    );
    return id;
  }

  async function insertJob(
    overrides: Record<string, unknown>,
    outboxEventId?: string,
  ): Promise<string> {
    const id = randomUUID();
    const row: Record<string, unknown> = {
      id,
      requested_by: requesterId,
      outbox_event_id: outboxEventId ?? (await insertEvent(exportEventType)),
      filters: JSON.stringify({ status: 'ACTIVE' }),
      ...overrides,
    };
    const columns = Object.keys(row);
    await dataSource.query(
      `INSERT INTO export_jobs (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => row[column]),
    );
    return id;
  }

  function completedShape(): Record<string, unknown> {
    const started = new Date(Date.UTC(2026, 8, 17, 8, 0, 1));
    return {
      status: 'COMPLETED',
      object_key: `exports/rooms/${randomUUID()}.xlsx`,
      row_count: 23,
      file_size_bytes: 18_462,
      content_sha256: 'a'.repeat(64),
      started_at: started,
      completed_at: new Date(started.getTime() + 3_000),
      expires_at: new Date(started.getTime() + 86_400_000),
    };
  }

  function failedShape(): Record<string, unknown> {
    return {
      status: 'FAILED',
      started_at: new Date(Date.UTC(2026, 8, 17, 8, 0, 1)),
      failed_at: new Date(Date.UTC(2026, 8, 17, 8, 0, 4)),
      last_error_code: 'EXPORT_ROW_LIMIT_EXCEEDED',
    };
  }

  async function readEvent(
    id: string,
  ): Promise<{ status: string; locked_by: string | null }> {
    const rows: Array<{ status: string; locked_by: string | null }> =
      await dataSource.query(
        'SELECT status, locked_by FROM outbox_events WHERE id = ?',
        [id],
      );
    return rows[0];
  }

  async function expireLease(id: string, claimToken: string): Promise<void> {
    await dataSource.query(
      `UPDATE outbox_events
       SET status = ?, locked_at = NOW(6), lock_expires_at = NOW(6) - INTERVAL 1 SECOND,
           locked_by = ?, attempts = 1
       WHERE id = ?`,
      [OutboxEventStatus.Processing, claimToken, id],
    );
  }

  async function tableExists(table: string): Promise<boolean> {
    const rows: Array<{ tableCount: number }> = await dataSource.query(
      `SELECT COUNT(*) AS tableCount FROM information_schema.tables
       WHERE table_schema = ? AND table_name = ?`,
      [disposableDatabase, table],
    );
    return Number(rows[0].tableCount) > 0;
  }

  async function indexExists(table: string, index: string): Promise<boolean> {
    return (await indexColumns(table, index)).length > 0;
  }

  async function indexColumns(table: string, index: string): Promise<string[]> {
    const rows: Array<{ columnName: string }> = await dataSource.query(
      `SELECT column_name AS columnName FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ? AND index_name = ?
       ORDER BY seq_in_index ASC`,
      [disposableDatabase, table, index],
    );
    return rows.map((row) => row.columnName);
  }

  async function collationOf(table: string, column: string): Promise<string> {
    const rows: Array<{ collationName: string }> = await dataSource.query(
      `SELECT collation_name AS collationName FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
      [disposableDatabase, table, column],
    );
    return rows[0].collationName;
  }

  function minutesAgo(minutes: number): Date {
    return new Date(Date.now() - minutes * 60_000);
  }
});
