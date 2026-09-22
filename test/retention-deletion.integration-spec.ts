import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import {
  createRetentionConfiguration,
  type RetentionWindowConfiguration,
} from '../src/config/retention.config';
import { createTypeOrmOptions } from '../src/database/database.options';
import { OutboxEventStatus } from '../src/common/outbox/outbox.enums';
import { ExportJobStatus } from '../src/reports/entities/export-job.enums';
import { ObjectStorageProvider } from '../src/common/storage/object-storage.provider';
import { StorageCleanupService } from '../src/files/storage-cleanup.service';
import { notificationEventTypes } from '../src/notifications/notification-event';
import { roomExportEventTypes } from '../src/reports/room-export.constants';
import { RetentionDeleteRepository } from '../src/retention/retention-delete.repository';
import { RetentionTasksService } from '../src/retention/retention-tasks.service';
import { retentionConfig } from '../src/config/retention.config';
import { reportsConfig } from '../src/config/reports.config';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(90_000);

const exportEventType = roomExportEventTypes[0];

/**
 * The slice where a mistake is not recoverable, so the assertions are mostly about what
 * survives rather than what goes.
 *
 * The object store is a stub here, not MinIO. What is under test is the order of the
 * deletions and which rows are spared; whether the AWS client can delete an object is
 * Phase 6's question and `ObjectStorageProvider` has its own suite. Stubbing it is also
 * the only way to make "the provider refused" a case rather than an outage.
 */
describe('Phase 7 deletions', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let context: INestApplicationContext;
  let tasks: RetentionTasksService;
  let windows: RetentionWindowConfiguration;
  let userId: string;
  let storage: { deleteObject: jest.Mock };

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p7_t03_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Deletion prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

    storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RetentionTasksService,
        RetentionDeleteRepository,
        { provide: ObjectStorageProvider, useValue: storage },
        // Its own suite covers it; here it would only bring MinIO into a test about
        // deletion order.
        {
          provide: StorageCleanupService,
          useValue: {
            run: jest
              .fn()
              .mockResolvedValue({ claimed: 0, deleted: 0, retryable: 0 }),
          },
        },
        {
          provide: retentionConfig.KEY,
          useValue: createRetentionConfiguration(environment),
        },
        {
          provide: reportsConfig.KEY,
          useValue: { storage: { timeoutMs: 1_000 } },
        },
      ],
    }).compile();
    context = await moduleRef.init();
    tasks = context.get(RetentionTasksService);
    windows = createRetentionConfiguration(environment).windows;
    userId = await insertUser();
  });

  beforeEach(async () => {
    storage.deleteObject.mockReset().mockResolvedValue(undefined);
    await dataSource.query('DELETE FROM email_send_attempts');
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM export_jobs');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM auth_sessions');
    await dataSource.query('DELETE FROM idempotency_keys');
  });

  afterAll(async () => {
    if (context) await context.close();
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

  describe('the notification chain', () => {
    it('leaves no orphaned send attempt behind the event it belonged to', async () => {
      // The trap this whole suite exists for. `email_send_attempts` carries no foreign
      // key to `outbox_events`, so deleting the event first succeeds and leaves these
      // rows with nothing pointing at them and nothing complaining. Only a count can
      // see it.
      const eventId = await insertDueNotificationEvent();
      await insertDelivery(eventId);
      await insertSendAttempt(eventId);
      await insertSendAttempt(eventId);

      const outcome = await tasks.runBatch(
        dataSource,
        'notification-events',
        10,
      );

      expect(outcome.counts).toEqual({
        email_send_attempts: 2,
        email_deliveries: 1,
        outbox_events: 1,
      });
      expect(await orphanedSendAttempts()).toBe(0);
      expect(await count('email_send_attempts')).toBe(0);
      expect(await count('outbox_events')).toBe(0);
    });

    it('retains a failed event and everything hanging off it', async () => {
      // Phase 5's redrive depends on this row. Age is not a reason to delete evidence
      // somebody may still act on.
      const failed = await insertOutboxEvent(
        OutboxEventStatus.Failed,
        oldEnough(windows.notificationEventHours),
      );
      await insertSendAttempt(failed);

      const outcome = await tasks.runBatch(
        dataSource,
        'notification-events',
        10,
      );

      expect(outcome.counts).toEqual({});
      expect(await count('outbox_events')).toBe(1);
      expect(await count('email_send_attempts')).toBe(1);
    });

    it('never touches the export family, whose events belong to another task', async () => {
      const exportEvent = await insertOutboxEvent(
        OutboxEventStatus.Processed,
        oldEnough(windows.notificationEventHours),
        exportEventType,
      );
      await insertExportJob(ExportJobStatus.Queued, 'NOW(6)', exportEvent);

      const outcome = await tasks.runBatch(
        dataSource,
        'notification-events',
        10,
      );

      // An export job stuck `QUEUED` is never terminal, so `export-results` will not
      // collect it either. Counting it here would have meant reporting a row retention
      // could never delete, and then meeting ER_ROW_IS_REFERENCED_2 on it.
      expect(outcome.counts).toEqual({});
      expect(await count('outbox_events')).toBe(1);
    });

    it('stops at the batch size and says there is more', async () => {
      for (let index = 0; index < 3; index += 1) {
        await insertDueNotificationEvent();
      }

      const first = await tasks.runBatch(dataSource, 'notification-events', 2);
      expect(first.counts.outbox_events).toBe(2);
      expect(first.moreWaiting).toBe(true);

      const second = await tasks.runBatch(dataSource, 'notification-events', 2);
      expect(second.counts.outbox_events).toBe(1);
      expect(second.moreWaiting).toBe(false);
    });
  });

  describe('the export chain', () => {
    it('removes the object before the rows that name it', async () => {
      const jobId = await insertTerminalExportJob('exports/rooms/a.xlsx');

      const outcome = await tasks.runBatch(dataSource, 'export-results', 10);

      expect(storage.deleteObject).toHaveBeenCalledWith(
        expect.objectContaining({ objectKey: 'exports/rooms/a.xlsx' }),
      );
      expect(outcome.counts).toEqual({
        export_objects: 1,
        export_jobs: 1,
        outbox_events: 1,
      });
      expect(await count('export_jobs')).toBe(0);
      expect(await count('outbox_events')).toBe(0);
      expect(jobId).toBeDefined();
    });

    it('keeps the rows when the provider refuses, so the object stays due', async () => {
      await insertTerminalExportJob('exports/rooms/b.xlsx');
      storage.deleteObject.mockRejectedValue(new Error('provider down'));

      const outcome = await tasks.runBatch(dataSource, 'export-results', 10);

      // Rows deleted with the object intact would leave a file nothing can ever name
      // again. The row is the only thing that knows the key.
      expect(outcome.counts).toEqual({});
      expect(outcome.retryableFailures).toBe(1);
      expect(await count('export_jobs')).toBe(1);
      expect(await count('outbox_events')).toBe(1);
    });

    it('never deletes an object another job still points at', async () => {
      // Phase 6 lets a losing attempt stage an object under a key a winner may also
      // have published. Removing it would break a download that is entitled to work.
      const shared = 'exports/rooms/shared.xlsx';
      await insertTerminalExportJob(shared);
      await insertExportJob(
        ExportJobStatus.Completed,
        'NOW(6)',
        undefined,
        shared,
      );

      const outcome = await tasks.runBatch(dataSource, 'export-results', 10);

      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(outcome.counts.export_jobs).toBe(1);
      // The live job and its event survive; only the aged one goes.
      expect(await count('export_jobs')).toBe(1);
    });

    it('collects a failed job, which never had an object at all', async () => {
      await insertExportJob(
        ExportJobStatus.Failed,
        oldEnough(windows.exportTerminalHours),
      );

      const outcome = await tasks.runBatch(dataSource, 'export-results', 10);

      expect(storage.deleteObject).not.toHaveBeenCalled();
      expect(outcome.counts).toEqual({ export_jobs: 1, outbox_events: 1 });
    });

    it('never takes a job out from under the worker generating it', async () => {
      // `expires_at` can be long past on a job still `QUEUED`. Age alone would delete
      // it mid-generation.
      await insertExportJob(
        ExportJobStatus.Queued,
        oldEnough(windows.exportTerminalHours),
      );
      await insertExportJob(
        ExportJobStatus.Processing,
        oldEnough(windows.exportTerminalHours),
      );

      const outcome = await tasks.runBatch(dataSource, 'export-results', 10);

      expect(outcome.counts).toEqual({});
      expect(await count('export_jobs')).toBe(2);
    });
  });

  describe('the independent purges', () => {
    it('deletes expired sessions and keeps the refreshable one', async () => {
      await insertSession(oldEnough(windows.sessionHours));
      await insertSession('NOW(6) + INTERVAL 30 DAY');

      const outcome = await tasks.runBatch(dataSource, 'auth-sessions', 10);

      expect(outcome.counts).toEqual({ auth_sessions: 1 });
      expect(await count('auth_sessions')).toBe(1);
    });

    it('deletes expired idempotency keys and keeps the live one', async () => {
      await insertIdempotencyKey('NOW(6) - INTERVAL 1 MICROSECOND');
      await insertIdempotencyKey('NOW(6) + INTERVAL 1 HOUR');

      const outcome = await tasks.runBatch(dataSource, 'idempotency-keys', 10);

      expect(outcome.counts).toEqual({ idempotency_keys: 1 });
      expect(await count('idempotency_keys')).toBe(1);
    });
  });

  // --- fixtures ---

  function oldEnough(windowHours: number): string {
    return `NOW(6) - INTERVAL ${windowHours} HOUR - INTERVAL 1 MICROSECOND`;
  }

  async function insertDueNotificationEvent(): Promise<string> {
    return insertOutboxEvent(
      OutboxEventStatus.Processed,
      oldEnough(windows.notificationEventHours),
    );
  }

  async function insertTerminalExportJob(objectKey: string): Promise<string> {
    return insertExportJob(
      ExportJobStatus.Completed,
      oldEnough(windows.exportTerminalHours),
      undefined,
      objectKey,
    );
  }

  async function insertUser(): Promise<string> {
    const inserted: { insertId: number } = await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Retention Admin', 'ADMIN', 'ACTIVE', NOW(6))`,
      [`retention-${randomUUID()}@hotel.test`],
    );
    return String(inserted.insertId);
  }

  async function insertSession(refreshExpiresAt: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, refresh_expires_at)
       VALUES (?, ?, ?, ${refreshExpiresAt})`,
      [randomUUID(), userId, randomUUID().replaceAll('-', '')],
    );
  }

  async function insertIdempotencyKey(expiresAt: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO idempotency_keys
         (actor_user_id, operation, idempotency_key, request_fingerprint,
          status, response_status, response_body, expires_at)
       VALUES (?, 'booking.create', ?, ?, 'COMPLETED', 201, '{}', ${expiresAt})`,
      [userId, randomUUID(), randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );
  }

  async function insertOutboxEvent(
    status: OutboxEventStatus,
    availableAt: string,
    eventType: string = notificationEventTypes[0],
  ): Promise<string> {
    const id = randomUUID();
    const lease =
      status === OutboxEventStatus.Processing
        ? "NOW(6), NOW(6) + INTERVAL 1 MINUTE, 'worker-1'"
        : 'NULL, NULL, NULL';
    const processedAt =
      status === OutboxEventStatus.Processed ? 'NOW(6)' : 'NULL';
    const failedAt = status === OutboxEventStatus.Failed ? 'NOW(6)' : 'NULL';
    const errorCode =
      status === OutboxEventStatus.Failed ? "'MAIL_PERMANENT'" : 'NULL';
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key,
          locked_at, lock_expires_at, locked_by, processed_at, failed_at,
          last_error_code)
       VALUES (?, ?, '{}', ${availableAt}, ?, ?, ${lease}, ${processedAt},
               ${failedAt}, ${errorCode})`,
      [id, eventType, status, randomUUID()],
    );
    return id;
  }

  async function insertDelivery(eventId: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO email_deliveries
         (outbox_event_id, recipient, template_key, locale, status, sent_at)
       VALUES (?, 'guest@hotel.test', 'booking.confirmed', 'en', 'SENT', NOW(6))`,
      [eventId],
    );
  }

  async function insertSendAttempt(eventId: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO email_send_attempts
         (outbox_event_id, template_key, claim_token, attempt, accepted_at)
       VALUES (?, 'booking.confirmed', ?, 1, NOW(6))`,
      [eventId, randomUUID()],
    );
  }

  async function insertExportJob(
    status: ExportJobStatus,
    updatedAt: string,
    eventId?: string,
    objectKey?: string,
  ): Promise<string> {
    const outboxEventId =
      eventId ??
      (await insertOutboxEvent(
        OutboxEventStatus.Processed,
        'NOW(6)',
        exportEventType,
      ));
    const id = randomUUID();
    const completed = status === ExportJobStatus.Completed;
    const failed = status === ExportJobStatus.Failed;
    await dataSource.query(
      `INSERT INTO export_jobs
         (id, requested_by, outbox_event_id, status, filters, object_key,
          row_count, file_size_bytes, content_sha256, started_at, completed_at,
          expires_at, failed_at, last_error_code, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ${updatedAt})`,
      [
        id,
        userId,
        outboxEventId,
        status,
        completed ? (objectKey ?? `exports/rooms/${id}.xlsx`) : null,
        completed ? 5 : null,
        completed ? 1_024 : null,
        completed ? '0'.repeat(64) : null,
        completed || failed ? new Date() : null,
        completed ? new Date() : null,
        completed ? new Date() : null,
        failed ? new Date() : null,
        failed ? 'EXPORT_ATTEMPT_FAILED' : null,
      ],
    );
    return id;
  }

  async function count(table: string): Promise<number> {
    const rows: Array<{ total: number }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM ${table}`,
    );
    return Number(rows[0].total);
  }

  /** Send attempts whose event is gone. The database will never report these. */
  async function orphanedSendAttempts(): Promise<number> {
    const rows: Array<{ total: number }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM email_send_attempts a
       LEFT JOIN outbox_events e ON e.id = a.outbox_event_id
       WHERE e.id IS NULL`,
    );
    return Number(rows[0].total);
  }
});
