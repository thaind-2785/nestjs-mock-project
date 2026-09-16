import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(60_000);

/**
 * The revert contract of the Phase 5 schema, exercised against real MySQL.
 *
 * A migration that has never been reverted is a migration whose `down` is a guess, and
 * these two refuse to run once the evidence they protect exists - which is a behaviour
 * a deployment discovers at the worst possible moment unless a test discovers it first.
 */
describe('Phase 5 migration revert and reapply', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;

  beforeEach(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_mig_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Migration integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

  it('reverts and reapplies the acceptance schema before any evidence exists', async () => {
    expect(await tableExists('email_send_attempts')).toBe(true);

    await dataSource.undoLastMigration();
    expect(await tableExists('email_send_attempts')).toBe(false);

    // Reapplied on the same database rather than a fresh one: a `down` that leaves
    // residue - an orphaned index, a column it forgot - fails here and nowhere else.
    await dataSource.runMigrations();
    expect(await tableExists('email_send_attempts')).toBe(true);
    const columns = await columnNames('email_send_attempts');
    expect(columns).toEqual([
      'id',
      'outbox_event_id',
      'template_key',
      'provider_message_id',
      'claim_token',
      'attempt',
      'accepted_at',
      'created_at',
    ]);
  });

  it('keeps the index the redrive guard reads through', async () => {
    // Dropping it from the migration was invisible to every suite, while `EXPLAIN`
    // shows the guard depends on it (`ref`, `Using index`).
    const columns: Array<{ COLUMN_NAME: string }> = await dataSource.query(
      `SELECT COLUMN_NAME FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'email_send_attempts'
         AND index_name = 'idx_email_send_attempts_event'
       ORDER BY SEQ_IN_INDEX`,
    );

    expect(columns.map((column) => column.COLUMN_NAME)).toEqual([
      'outbox_event_id',
      'accepted_at',
    ]);
  });

  it('refuses to revert once a provider acceptance is recorded', async () => {
    await dataSource.query(
      `INSERT INTO email_send_attempts
         (outbox_event_id, template_key, provider_message_id, claim_token, attempt, accepted_at)
       VALUES (?, 'booking.confirmed.v1', '<id@fixture>', 'token', 1, NOW(6))`,
      [randomUUID()],
    );

    // Dropping the table would destroy the only record that a guest was mailed, and
    // silently remove the redrive command's duplicate guard with it.
    await expect(dataSource.undoLastMigration()).rejects.toThrow(
      /EMAIL_SEND_ATTEMPT_REVERT_BLOCKED/,
    );
    expect(await tableExists('email_send_attempts')).toBe(true);
  });

  it('refuses to revert the delivery schema once a delivery exists', async () => {
    // The acceptance schema comes off first; it is the delivery schema underneath
    // that carries the older guard.
    await dataSource.undoLastMigration();
    // `email_deliveries` does carry a restrictive foreign key, so the delivery needs
    // its event. `email_send_attempts` deliberately does not - see that migration.
    const eventId = randomUUID();
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key, attempts, created_at, updated_at)
       VALUES (?, 'booking.confirmed', '{}', NOW(6), 'PENDING', ?, 0, NOW(6), NOW(6))`,
      [eventId, `migration:${eventId}`],
    );
    await dataSource.query(
      `INSERT INTO email_deliveries
         (outbox_event_id, recipient, template_key, locale, status, attempts)
       VALUES (?, 'owner@example.test', 'booking.confirmed.v1', 'vi', 'PENDING', 0)`,
      [eventId],
    );

    await expect(dataSource.undoLastMigration()).rejects.toThrow(
      /NOTIFICATION_DELIVERY_REVERT_BLOCKED/,
    );
    expect(await tableExists('email_deliveries')).toBe(true);
  });

  async function tableExists(name: string): Promise<boolean> {
    const rows: Array<{ total: string | number }> = await dataSource.query(
      `SELECT COUNT(*) AS total FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [name],
    );
    return Number(rows[0].total) > 0;
  }

  async function columnNames(name: string): Promise<string[]> {
    const rows: Array<{ COLUMN_NAME: string }> = await dataSource.query(
      `SELECT COLUMN_NAME FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ORDINAL_POSITION`,
      [name],
    );
    return rows.map((row) => row.COLUMN_NAME);
  }
});
