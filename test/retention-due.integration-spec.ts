import { randomUUID } from 'node:crypto';
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
import {
  retentionDuePredicate,
  retentionDuePredicates,
} from '../src/retention/retention-due';
import { RetentionDueRepository } from '../src/retention/retention-due.repository';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(90_000);

/**
 * Every predicate is `<= NOW(6)`, so the assertions below seed a row on each side of
 * the boundary rather than one comfortably inside it: a predicate off by a day and one
 * off by a microsecond both pass a test that only seeds ancient rows.
 *
 * The two margins are deliberately different sizes. A row past the boundary stays past
 * it however long the test takes, so a microsecond is enough. A row short of it is
 * moving towards it while the test runs, and a microsecond of headroom is smaller than
 * the milliseconds between the insert and the query - so the near side gets an hour,
 * which is still a thousandth of the smallest window here and cannot be reached by a
 * test run.
 */
const pastBoundary = 'INTERVAL 1 MICROSECOND';
const shortOfBoundary = 'INTERVAL 1 HOUR';
describe('Phase 7 due work', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let due: RetentionDueRepository;
  let windows: RetentionWindowConfiguration;
  let userId: string;

  beforeEach(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p7_t02_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Due-work prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
    due = new RetentionDueRepository();
    windows = createRetentionConfiguration(environment).windows;
    userId = await insertUser();
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

  describe('boundaries', () => {
    it('collects a session one microsecond past its window and not one before', async () => {
      await insertSession(
        `NOW(6) - INTERVAL ${windows.sessionHours} HOUR - ${pastBoundary}`,
      );
      await insertSession(
        `NOW(6) - INTERVAL ${windows.sessionHours} HOUR + ${shortOfBoundary}`,
      );
      // A session still refreshable survives whatever else is true about it.
      await insertSession('NOW(6) + INTERVAL 30 DAY');

      expect((await sample('auth-sessions')).dueCount).toBe(1);
    });

    it('collects an idempotency key the moment it expires, using the row own window', async () => {
      // No window parameter: `expires_at` already carries the one SPEC-006 promised.
      await insertIdempotencyKey(`NOW(6) - ${pastBoundary}`);
      await insertIdempotencyKey(`NOW(6) + ${shortOfBoundary}`);

      expect((await sample('idempotency-keys')).dueCount).toBe(1);
    });

    it('leaves a storage task that is not available yet, or is claimed', async () => {
      await insertStorageTask(`NOW(6) - ${pastBoundary}`, null);
      // An upload safeguard before its grace passes is still protecting a live write.
      await insertStorageTask(`NOW(6) + ${shortOfBoundary}`, null);
      // Claimed by a worker whose lease is live: its work, not retention's.
      await insertStorageTask(
        'NOW(6) - INTERVAL 1 HOUR',
        'NOW(6) + INTERVAL 1 HOUR',
      );

      expect((await sample('storage-tasks')).dueCount).toBe(1);
    });

    it('collects processed outbox events and retains everything else', async () => {
      const old = `NOW(6) - INTERVAL ${windows.notificationEventHours} HOUR - ${pastBoundary}`;
      const young = `NOW(6) - INTERVAL ${windows.notificationEventHours} HOUR + ${shortOfBoundary}`;
      await insertOutboxEvent(OutboxEventStatus.Processed, old);
      await insertOutboxEvent(OutboxEventStatus.Processed, young);
      // Pending and processing events are live work, whatever their age.
      await insertOutboxEvent(OutboxEventStatus.Pending, old);
      await insertOutboxEvent(OutboxEventStatus.Processing, old);

      expect((await sample('notification-events')).dueCount).toBe(1);
    });

    it('never collects an export job that has not reached a terminal status', async () => {
      const old = `NOW(6) - INTERVAL ${windows.exportTerminalHours} HOUR - ${pastBoundary}`;
      await insertExportJob(ExportJobStatus.Completed, old);
      await insertExportJob(ExportJobStatus.Failed, old);
      // The trap: `expires_at` can be long past on a job a worker is still generating.
      // Age alone would delete it out from under that worker.
      await insertExportJob(ExportJobStatus.Queued, old);
      await insertExportJob(ExportJobStatus.Processing, old);
      await insertExportJob(
        ExportJobStatus.Completed,
        `NOW(6) - INTERVAL ${windows.exportTerminalHours} HOUR + ${shortOfBoundary}`,
      );

      expect((await sample('export-results')).dueCount).toBe(2);
    });
  });

  describe('readings', () => {
    it('reports the age of the oldest waiting row, not of the newest', async () => {
      await insertIdempotencyKey('NOW(6) - INTERVAL 10 DAY');
      await insertIdempotencyKey('NOW(6) - INTERVAL 1 HOUR');

      const reading = await sample('idempotency-keys');
      expect(reading.dueCount).toBe(2);
      // A count that is large but young is a busy night; small but old is a task that
      // is not running at all. The age is what tells them apart.
      expect(reading.oldestDueAgeMs).toBeGreaterThan(9 * 24 * 60 * 60 * 1_000);
    });

    it('measures an export backlog from when jobs became terminal, failures included', async () => {
      // A failed job has no `completed_at` and no `expires_at` at all, so an anchor on
      // either would skip it silently and report the backlog as younger than it is -
      // a real number about the wrong rows.
      await insertExportJob(ExportJobStatus.Failed, 'NOW(6) - INTERVAL 60 DAY');
      await insertExportJob(
        ExportJobStatus.Completed,
        'NOW(6) - INTERVAL 20 DAY',
      );

      const reading = await sample('export-results');
      expect(reading.dueCount).toBe(2);
      expect(reading.oldestDueAgeMs).toBeGreaterThan(59 * 24 * 60 * 60 * 1_000);
    });

    it('reports zero age when nothing is due, rather than an age of never', async () => {
      const reading = await sample('idempotency-keys');
      expect(reading.dueCount).toBe(0);
      expect(reading.oldestDueAgeMs).toBe(0);
    });
  });

  describe('query shape', () => {
    beforeEach(async () => {
      // One row in each table before asking for a plan. On an empty table MySQL
      // short-circuits `MIN()` to "No matching min/max row" and returns no plan at
      // all - every column NULL - so an EXPLAIN assertion there would be testing
      // emptiness rather than the query.
      await insertSession('NOW(6) - INTERVAL 30 DAY');
      await insertIdempotencyKey('NOW(6) - INTERVAL 30 DAY');
      await insertStorageTask('NOW(6) - INTERVAL 1 DAY', null);
      await insertOutboxEvent(
        OutboxEventStatus.Processed,
        'NOW(6) - INTERVAL 60 DAY',
      );
      await insertExportJob(
        ExportJobStatus.Completed,
        'NOW(6) - INTERVAL 60 DAY',
      );
    });

    it.each(retentionDuePredicates.map((predicate) => [predicate.taskName]))(
      '%s answers from its index rather than scanning',
      async (taskName) => {
        const predicate = retentionDuePredicate(taskName);
        const plan = await due.explain(dataSource.manager, predicate, windows);
        // An index named only in a comment is a wish. `possible_keys` is what makes it
        // a claim: it says the optimiser can serve this predicate from that index.
        // Whether it picks it depends on table size, and on a fixture this small a
        // full scan really is cheaper - so asserting the chosen key would assert
        // something false about a correct optimiser.
        expect(plan.possibleKeys).toContain(predicate.expectedIndex);
      },
    );
  });

  async function sample(taskName: Parameters<typeof retentionDuePredicate>[0]) {
    return due.sample(
      dataSource.manager,
      retentionDuePredicate(taskName),
      windows,
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
      `INSERT INTO auth_sessions
         (id, user_id, refresh_token_hash, refresh_expires_at)
       VALUES (?, ?, ?, ${refreshExpiresAt})`,
      [randomUUID(), userId, randomUUID().replaceAll('-', '')],
    );
  }

  async function insertIdempotencyKey(expiresAt: string): Promise<void> {
    await dataSource.query(
      // COMPLETED requires a stored response: the table refuses a replayable key with
      // nothing to replay.
      `INSERT INTO idempotency_keys
         (actor_user_id, operation, idempotency_key, request_fingerprint,
          status, response_status, response_body, expires_at)
       VALUES (?, 'booking.create', ?, ?, 'COMPLETED', 201, '{}', ${expiresAt})`,
      [userId, randomUUID(), randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );
  }

  async function insertStorageTask(
    availableAt: string,
    lockExpiresAt: string | null,
  ): Promise<void> {
    await dataSource.query(
      // The lock columns are all-or-nothing, so a claimed fixture sets all three.
      `INSERT INTO storage_cleanup_tasks
         (id, object_key, reason, available_at, locked_at, lock_expires_at, locked_by)
       VALUES (?, ?, 'DETACHED_OBJECT', ${availableAt},
               ${lockExpiresAt ? 'NOW(6)' : 'NULL'},
               ${lockExpiresAt ?? 'NULL'},
               ${lockExpiresAt ? '?' : 'NULL'})`,
      lockExpiresAt
        ? [randomUUID(), `exports/rooms/${randomUUID()}.xlsx`, 'worker-1']
        : [randomUUID(), `exports/rooms/${randomUUID()}.xlsx`],
    );
  }

  async function insertOutboxEvent(
    status: OutboxEventStatus,
    availableAt: string,
  ): Promise<string> {
    const id = randomUUID();
    // Each status carries the lease and outcome columns its own check demands: a
    // processed event owns no lease and has a `processed_at`, a processing one owns a
    // lease and has neither.
    const lease =
      status === OutboxEventStatus.Processing
        ? "NOW(6), NOW(6) + INTERVAL 1 MINUTE, 'worker-1'"
        : 'NULL, NULL, NULL';
    const processedAt =
      status === OutboxEventStatus.Processed ? 'NOW(6)' : 'NULL';
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key,
          locked_at, lock_expires_at, locked_by, processed_at)
       VALUES (?, 'booking.confirmed', '{}', ${availableAt}, ?, ?,
               ${lease}, ${processedAt})`,
      [id, status, randomUUID()],
    );
    return id;
  }

  async function insertExportJob(
    status: ExportJobStatus,
    updatedAt: string,
  ): Promise<void> {
    const eventId = await insertOutboxEvent(
      OutboxEventStatus.Processed,
      'NOW(6)',
    );
    const terminal = status === ExportJobStatus.Completed;
    const failed = status === ExportJobStatus.Failed;
    await dataSource.query(
      `INSERT INTO export_jobs
         (id, requested_by, outbox_event_id, status, filters, object_key,
          row_count, file_size_bytes, content_sha256, started_at, completed_at,
          expires_at, failed_at, last_error_code, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ${updatedAt})`,
      [
        randomUUID(),
        userId,
        eventId,
        status,
        terminal ? `exports/rooms/${randomUUID()}.xlsx` : null,
        terminal ? 5 : null,
        terminal ? 1_024 : null,
        terminal ? '0'.repeat(64) : null,
        terminal || failed ? new Date() : null,
        terminal ? new Date() : null,
        terminal ? new Date() : null,
        failed ? new Date() : null,
        failed ? 'EXPORT_ATTEMPT_FAILED' : null,
      ],
    );
  }
});
