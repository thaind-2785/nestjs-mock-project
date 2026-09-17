import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource, IsNull } from 'typeorm';
import { OutboxEventStatus } from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import { applicationMigrations } from './fixtures/application-migrations';
import {
  EmailDeliveryLocale,
  EmailDeliveryStatus,
} from '../src/notifications/entities/notification.enums';

jest.setTimeout(30_000);

describe('Phase 5 notification delivery persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t02_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Notification delivery integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities: [OutboxEvent, EmailDelivery],
          migrations: applicationMigrations,
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  beforeEach(async () => {
    // Restores whatever a previous test reverted, so each one starts from the whole
    // stack rather than from its predecessor's leftovers.
    await dataSource.runMigrations();
    await dataSource.query('DELETE FROM email_send_attempts');
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
    // This suite is about the delivery migration and calls `undoLastMigration` expecting
    // to get it. Three migrations now sit on top - the Phase 6 export schema, the
    // backlog index, then the acceptance schema - so peel all three and leave the
    // stack these tests were written against.
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();
    await dataSource.undoLastMigration();
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

  it('creates the delivery table with its logical uniqueness, index, and restrictive key', async () => {
    expect(dataSource.options.synchronize).toBe(false);
    expect(await tableNames()).toEqual(['email_deliveries']);
    expect(await indexColumns('uq_email_deliveries_logical')).toEqual([
      'outbox_event_id',
      'template_key',
    ]);
    expect(await indexColumns('idx_email_deliveries_status_created')).toEqual([
      'status',
      'created_at',
      'id',
    ]);
    // The stored column and the enum the application renders with cannot drift apart
    // without one of them failing here.
    expect(await columnType('email_deliveries', 'locale')).toBe(
      `enum(${Object.values(EmailDeliveryLocale)
        .map((locale) => `'${locale}'`)
        .join(',')})`,
    );

    const [foreignKey] = await dataSource.query<
      Array<{ DELETE_RULE: string; REFERENCED_TABLE_NAME: string }>
    >(
      `SELECT r.DELETE_RULE, r.REFERENCED_TABLE_NAME
       FROM information_schema.referential_constraints r
       WHERE r.CONSTRAINT_SCHEMA = DATABASE()
         AND r.CONSTRAINT_NAME = 'fk_email_deliveries_outbox_event'`,
    );
    expect(foreignKey).toEqual({
      DELETE_RULE: 'RESTRICT',
      REFERENCED_TABLE_NAME: 'outbox_events',
    });
  });

  it('carries every Phase 4 outbox shape across the additive migration', async () => {
    // The legacy rows are written against the pre-migration table through raw SQL,
    // because the entity already carries columns that table does not have. Inserting
    // them afterwards would only prove new rows are accepted, not that ALTER TABLE
    // and the widened CHECK survive data written before Phase 5 existed.
    await dataSource.undoLastMigration();
    await dataSource.query(
      `INSERT INTO outbox_events
         (id, event_type, payload, available_at, status, idempotency_key, locked_at, lock_expires_at, locked_by, processed_at, attempts)
       VALUES
         (UUID(), 'booking.confirmed', '{"schemaVersion":1}', NOW(6), 'PENDING', 'booking.confirmed:A:2', NULL, NULL, NULL, NULL, 0),
         (UUID(), 'booking.rejected', '{"schemaVersion":1}', NOW(6), 'PROCESSING', 'booking.rejected:B:2', NOW(6), NOW(6) + INTERVAL 120 SECOND, 'claim-token', NULL, 1),
         (UUID(), 'booking.changed', '{"schemaVersion":1}', NOW(6), 'PROCESSED', 'booking.changed:C:3', NULL, NULL, NULL, NOW(6), 1)`,
    );

    await dataSource.runMigrations();

    const repository = dataSource.getRepository(OutboxEvent);
    expect(await repository.count()).toBe(3);
    // The added columns are absent evidence on rows that predate them, which is the
    // only shape the widened check permits for those states.
    expect(
      await repository.countBy({ lastErrorCode: IsNull(), failedAt: IsNull() }),
    ).toBe(3);
  });

  it('accepts a terminal outbox failure and refuses every contradictory shape', async () => {
    const repository = dataSource.getRepository(OutboxEvent);
    const failedAt = new Date();

    await repository.insert({
      ...pendingEvent('booking.confirmed:D:2'),
      status: OutboxEventStatus.Failed,
      failedAt,
      lastErrorCode: 'MAIL_RECIPIENT_INVALID',
      attempts: 5,
    });

    // A terminal failure without a code, or with a lease it no longer holds, would
    // leave an operator unable to tell why the event stopped or who owns it.
    await expect(
      repository.insert({
        ...pendingEvent('booking.confirmed:E:2'),
        status: OutboxEventStatus.Failed,
        failedAt,
        lastErrorCode: null,
      }),
    ).rejects.toThrow(/chk_outbox_events_lease_state/);
    await expect(
      repository.insert({
        ...pendingEvent('booking.confirmed:F:2'),
        status: OutboxEventStatus.Failed,
        failedAt,
        lastErrorCode: 'MAIL_PROVIDER_REJECTED',
        lockedBy: 'claim-token',
        lockedAt: failedAt,
        lockExpiresAt: failedAt,
      }),
    ).rejects.toThrow(/chk_outbox_events_lease_state/);
    // Success must clear the failure evidence rather than accumulate both.
    await expect(
      repository.insert({
        ...pendingEvent('booking.confirmed:G:2'),
        status: OutboxEventStatus.Processed,
        processedAt: failedAt,
        lastErrorCode: 'MAIL_PROVIDER_UNAVAILABLE',
      }),
    ).rejects.toThrow(/chk_outbox_events_lease_state/);
    await expect(
      repository.insert({
        ...pendingEvent('booking.confirmed:H:2'),
        status: OutboxEventStatus.Pending,
        failedAt,
      }),
    ).rejects.toThrow(/chk_outbox_events_lease_state/);

    expect(await repository.count()).toBe(1);
  });

  it('keeps one logical delivery per event and template', async () => {
    const event = await insertPendingEvent('booking.confirmed:I:2');
    const deliveries = dataSource.getRepository(EmailDelivery);
    // A fresh literal per insert: TypeORM writes the generated id back into the
    // object it was given, so a reused one would collide on the primary key and the
    // assertion below would pass without the logical key ever being tested.
    const delivery = () => ({
      outboxEventId: event.id,
      recipient: 'owner@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
    });

    await deliveries.insert(delivery());

    // The retry of an accepted-but-unrecorded send resolves to that same row; a
    // second insert is what "one logical delivery" forbids.
    await expect(deliveries.insert(delivery())).rejects.toThrow(
      /uq_email_deliveries_logical/,
    );
    // The recipient sits outside the key on purpose: a retry that re-resolved a
    // changed owner address must collide here rather than become a second message.
    await expect(
      deliveries.insert({ ...delivery(), recipient: 'owner-new@hotel.test' }),
    ).rejects.toThrow(/uq_email_deliveries_logical/);
    await deliveries.insert({
      ...delivery(),
      templateKey: 'booking.changed.v1',
    });

    expect(await deliveries.count()).toBe(2);
  });

  it('records provider acceptance and terminal failure in checked shapes', async () => {
    const deliveries = dataSource.getRepository(EmailDelivery);
    const now = new Date();
    // One event per state: three states of one event would now be three deliveries
    // of one event, which the logical key forbids.
    const [pendingEvent_, sentEvent, failedEvent] = await Promise.all([
      insertPendingEvent('booking.confirmed:J1:2'),
      insertPendingEvent('booking.confirmed:J2:2'),
      insertPendingEvent('booking.confirmed:J3:2'),
    ]);

    const pending = await deliveries.save({
      outboxEventId: pendingEvent_.id,
      recipient: 'pending@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.Vietnamese,
      // A retryable failure keeps the delivery pending and still names its cause.
      lastErrorCode: 'MAIL_PROVIDER_UNAVAILABLE',
      attempts: 1,
    });
    await deliveries.insert({
      outboxEventId: sentEvent.id,
      recipient: 'sent@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
      status: EmailDeliveryStatus.Sent,
      sentAt: now,
      providerMessageId: '<01H@hotel.test>',
      attempts: 2,
    });
    await deliveries.insert({
      outboxEventId: failedEvent.id,
      recipient: 'failed@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
      status: EmailDeliveryStatus.Failed,
      failedAt: now,
      lastErrorCode: 'MAIL_RECIPIENT_INVALID',
      attempts: 5,
    });

    expect(pending.status).toBe(EmailDeliveryStatus.Pending);
    const contradictions = [
      // Accepted by the provider with no acceptance time.
      { status: EmailDeliveryStatus.Sent, sentAt: null },
      // Sent and failed at once.
      { status: EmailDeliveryStatus.Sent, sentAt: now, failedAt: now },
      // Still sendable, yet already carrying a provider message id.
      {
        status: EmailDeliveryStatus.Pending,
        providerMessageId: '<02H@hotel.test>',
      },
      // Terminal without a reason.
      { status: EmailDeliveryStatus.Failed, failedAt: now },
    ];
    for (const [index, contradiction] of contradictions.entries()) {
      // Its own event too, so the state check is what rejects the row and not the
      // logical key of the row before it.
      const event = await insertPendingEvent(`booking.confirmed:K${index}:2`);
      await expect(
        deliveries.insert({
          outboxEventId: event.id,
          recipient: 'contradiction@hotel.test',
          templateKey: 'booking.confirmed.v1',
          locale: EmailDeliveryLocale.English,
          ...contradiction,
        }),
      ).rejects.toThrow(/chk_email_deliveries_state/);
    }

    expect(await deliveries.count()).toBe(3);
  });

  it('refuses to orphan or erase delivery evidence', async () => {
    const event = await insertPendingEvent('booking.confirmed:K:2');
    const deliveries = dataSource.getRepository(EmailDelivery);

    await expect(
      deliveries.insert({
        outboxEventId: randomUUID(),
        recipient: 'orphan@hotel.test',
        templateKey: 'booking.confirmed.v1',
        locale: EmailDeliveryLocale.English,
      }),
    ).rejects.toThrow(/fk_email_deliveries_outbox_event/);

    await deliveries.insert({
      outboxEventId: event.id,
      recipient: 'kept@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
    });

    await expect(
      dataSource.getRepository(OutboxEvent).delete(event.id),
    ).rejects.toThrow(/fk_email_deliveries_outbox_event/);
  });

  it('refuses a revert that would discard recorded delivery evidence', async () => {
    const event = await insertPendingEvent('booking.confirmed:L:2');
    await dataSource.getRepository(EmailDelivery).insert({
      outboxEventId: event.id,
      recipient: 'evidence@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
    });

    await expect(dataSource.undoLastMigration()).rejects.toThrow(
      /NOTIFICATION_DELIVERY_REVERT_BLOCKED/,
    );
    expect(await tableNames()).toEqual(['email_deliveries']);
  });

  it('refuses a revert that would discard a terminal outbox failure', async () => {
    // The guard has two branches and a delivery row is only one of them: an event
    // that failed permanently is evidence even when no delivery was ever created.
    await dataSource.getRepository(OutboxEvent).insert({
      ...pendingEvent('booking.confirmed:M:2'),
      status: OutboxEventStatus.Failed,
      failedAt: new Date(),
      lastErrorCode: 'MAIL_RECIPIENT_INVALID',
      attempts: 5,
    });

    await expect(dataSource.undoLastMigration()).rejects.toThrow(
      /NOTIFICATION_DELIVERY_REVERT_BLOCKED/,
    );
    expect(await tableNames()).toEqual(['email_deliveries']);
  });

  it('reverts and reapplies cleanly before its first delivery', async () => {
    await dataSource.undoLastMigration();

    expect(await tableNames()).toEqual([]);
    expect(await outboxStatusValues()).toBe(
      "enum('PENDING','PROCESSING','PROCESSED')",
    );

    await dataSource.runMigrations();

    expect(await tableNames()).toEqual(['email_deliveries']);
    expect(await outboxStatusValues()).toBe(
      "enum('PENDING','PROCESSING','PROCESSED','FAILED')",
    );
  });

  function pendingEvent(idempotencyKey: string) {
    return {
      id: randomUUID(),
      eventType: 'booking.confirmed',
      payload: { schemaVersion: 1 },
      availableAt: new Date(),
      status: OutboxEventStatus.Pending,
      idempotencyKey,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    };
  }

  async function insertPendingEvent(
    idempotencyKey: string,
  ): Promise<OutboxEvent> {
    return dataSource
      .getRepository(OutboxEvent)
      .save(pendingEvent(idempotencyKey));
  }

  async function tableNames(): Promise<string[]> {
    const tables = await dataSource.query<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.tables
       WHERE table_schema = DATABASE() AND TABLE_NAME = 'email_deliveries'`,
    );
    return tables.map((row) => row.TABLE_NAME);
  }

  async function indexColumns(indexName: string): Promise<string[]> {
    const columns = await dataSource.query<Array<{ COLUMN_NAME: string }>>(
      `SELECT COLUMN_NAME FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'email_deliveries'
         AND index_name = ? ORDER BY SEQ_IN_INDEX`,
      [indexName],
    );
    return columns.map((row) => row.COLUMN_NAME);
  }

  async function outboxStatusValues(): Promise<string> {
    return columnType('outbox_events', 'status');
  }

  async function columnType(table: string, column: string): Promise<string> {
    const [found] = await dataSource.query<Array<{ COLUMN_TYPE: string }>>(
      `SELECT COLUMN_TYPE FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column],
    );
    return found.COLUMN_TYPE;
  }
});
