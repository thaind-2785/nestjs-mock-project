import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
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
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
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
      'recipient',
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

  it('keeps every Phase 4 outbox shape valid after the additive migration', async () => {
    const repository = dataSource.getRepository(OutboxEvent);
    const lockedAt = new Date();

    await repository.insert(pendingEvent('booking.confirmed:A:2'));
    await repository.insert({
      ...pendingEvent('booking.rejected:B:2'),
      status: OutboxEventStatus.Processing,
      lockedAt,
      lockExpiresAt: new Date(lockedAt.getTime() + 120_000),
      lockedBy: 'claim-token',
      attempts: 1,
    });
    await repository.insert({
      ...pendingEvent('booking.changed:C:3'),
      status: OutboxEventStatus.Processed,
      processedAt: lockedAt,
      attempts: 1,
    });

    expect(await repository.count()).toBe(3);
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
    ).rejects.toBeDefined();
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
    ).rejects.toBeDefined();
    // Success must clear the failure evidence rather than accumulate both.
    await expect(
      repository.insert({
        ...pendingEvent('booking.confirmed:G:2'),
        status: OutboxEventStatus.Processed,
        processedAt: failedAt,
        lastErrorCode: 'MAIL_PROVIDER_UNAVAILABLE',
      }),
    ).rejects.toBeDefined();
    await expect(
      repository.insert({
        ...pendingEvent('booking.confirmed:H:2'),
        status: OutboxEventStatus.Pending,
        failedAt,
      }),
    ).rejects.toBeDefined();

    expect(await repository.count()).toBe(1);
  });

  it('keeps one logical delivery per event, recipient, and template', async () => {
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
    await deliveries.insert({
      ...delivery(),
      templateKey: 'booking.changed.v1',
    });

    expect(await deliveries.count()).toBe(2);
  });

  it('records provider acceptance and terminal failure in checked shapes', async () => {
    const event = await insertPendingEvent('booking.confirmed:J:2');
    const deliveries = dataSource.getRepository(EmailDelivery);
    const now = new Date();

    const pending = await deliveries.save({
      outboxEventId: event.id,
      recipient: 'pending@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.Vietnamese,
      // A retryable failure keeps the delivery pending and still names its cause.
      lastErrorCode: 'MAIL_PROVIDER_UNAVAILABLE',
      attempts: 1,
    });
    await deliveries.insert({
      outboxEventId: event.id,
      recipient: 'sent@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
      status: EmailDeliveryStatus.Sent,
      sentAt: now,
      providerMessageId: '<01H@hotel.test>',
      attempts: 2,
    });
    await deliveries.insert({
      outboxEventId: event.id,
      recipient: 'failed@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
      status: EmailDeliveryStatus.Failed,
      failedAt: now,
      lastErrorCode: 'MAIL_RECIPIENT_INVALID',
      attempts: 5,
    });

    expect(pending.status).toBe(EmailDeliveryStatus.Pending);
    for (const contradiction of [
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
    ]) {
      await expect(
        deliveries.insert({
          outboxEventId: event.id,
          recipient: `contradiction-${Math.random()}@hotel.test`,
          templateKey: 'booking.confirmed.v1',
          locale: EmailDeliveryLocale.English,
          ...contradiction,
        }),
      ).rejects.toBeDefined();
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
    ).rejects.toBeDefined();

    await deliveries.insert({
      outboxEventId: event.id,
      recipient: 'kept@hotel.test',
      templateKey: 'booking.confirmed.v1',
      locale: EmailDeliveryLocale.English,
    });

    await expect(
      dataSource.getRepository(OutboxEvent).delete(event.id),
    ).rejects.toBeDefined();
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
