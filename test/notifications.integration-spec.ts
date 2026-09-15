import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import {
  BookingStatus,
  OutboxEventStatus,
} from '../src/bookings/entities/booking.enums';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createNotificationsConfiguration } from '../src/config/notifications.config';
import { createTypeOrmOptions } from '../src/database/database.options';
import {
  DeliveryPreparationError,
  DeliveryPreparationService,
  deliveryPreparationErrorCodes,
} from '../src/notifications/delivery-preparation.service';
import { EmailDelivery } from '../src/notifications/entities/email-delivery.entity';
import {
  EmailDeliveryLocale,
  EmailDeliveryStatus,
} from '../src/notifications/entities/notification.enums';
import { EmailTemplateService } from '../src/notifications/email-template.service';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(30_000);

describe('Phase 5 notification preparation', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let preparation: DeliveryPreparationService;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p5_t03_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Notification preparation integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
    preparation = createPreparationService(environment.MAIL_DEFAULT_LOCALE);
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM email_deliveries');
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM users');
    await dataSource.query('DELETE FROM rooms');
    await dataSource.query('DELETE FROM room_types');
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

  it('snapshots the current normalized owner email on the first attempt', async () => {
    const ownerUserId = await insertOwner('ACTIVE', 'owner@hotel.test');
    const event = await insertEvent(ownerUserId, 'booking.confirmed');

    const prepared = await dataSource.transaction((manager) =>
      preparation.prepare(manager, event),
    );

    expect(prepared.recipient).toBe('owner@hotel.test');
    expect(prepared.locale).toBe(EmailDeliveryLocale.English);
    expect(prepared.templateKey).toBe('booking.confirmed.v1');
    expect(prepared.message.to).toBe('owner@hotel.test');
    expect(prepared.message.subject).toContain(event.payload.bookingId);
    expect(await dataSource.getRepository(EmailDelivery).find()).toMatchObject([
      {
        id: prepared.deliveryId,
        outboxEventId: event.id,
        recipient: 'owner@hotel.test',
        templateKey: 'booking.confirmed.v1',
        locale: EmailDeliveryLocale.English,
        status: EmailDeliveryStatus.Pending,
        attempts: 0,
      },
    ]);
  });

  it('notifies an inactive owner without changing account access state', async () => {
    const ownerUserId = await insertOwner('INACTIVE', 'inactive@hotel.test');
    const event = await insertEvent(ownerUserId, 'booking.rejected');

    const prepared = await dataSource.transaction((manager) =>
      preparation.prepare(manager, event),
    );

    expect(prepared.recipient).toBe('inactive@hotel.test');
    expect(prepared.message.text).toContain('Dates are unavailable.');
    const [owner] = await dataSource.query<Array<{ status: string }>>(
      'SELECT status FROM users WHERE id = ?',
      [ownerUserId],
    );
    expect(owner.status).toBe('INACTIVE');
  });

  it('reuses recipient, template, and locale snapshots after the owner email changes', async () => {
    const ownerUserId = await insertOwner('ACTIVE', 'first@hotel.test');
    const event = await insertEvent(ownerUserId, 'booking.confirmed');
    const first = await dataSource.transaction((manager) =>
      preparation.prepare(manager, event),
    );
    await dataSource.query('UPDATE users SET email = ? WHERE id = ?', [
      'changed@hotel.test',
      ownerUserId,
    ]);

    const retry = await dataSource.transaction((manager) =>
      preparation.prepare(manager, event),
    );

    expect(retry.deliveryId).toBe(first.deliveryId);
    expect(retry.recipient).toBe('first@hotel.test');
    expect(retry.templateKey).toBe(first.templateKey);
    expect(retry.locale).toBe(first.locale);
    expect(await dataSource.getRepository(EmailDelivery).count()).toBe(1);
  });

  it.each([
    ['an absent owner', undefined, deliveryPreparationErrorCodes.ownerNotFound],
    [
      'an invalid current email',
      'not-an-email',
      deliveryPreparationErrorCodes.recipientInvalid,
    ],
  ] as const)(
    'refuses %s without leaving a delivery row',
    async (_case, email, code) => {
      const ownerUserId = email
        ? await insertOwner('ACTIVE', email)
        : '18446744073709551615';
      const event = await insertEvent(ownerUserId, 'booking.confirmed');

      await expect(
        dataSource.transaction((manager) =>
          preparation.prepare(manager, event),
        ),
      ).rejects.toMatchObject<Partial<DeliveryPreparationError>>({ code });
      expect(await dataSource.getRepository(EmailDelivery).count()).toBe(0);
    },
  );

  it('snapshots the configured Vietnamese locale for only new deliveries', async () => {
    const ownerUserId = await insertOwner('ACTIVE', 'locale@hotel.test');
    const event = await insertEvent(ownerUserId, 'booking.confirmed');
    const vietnamesePreparation = createPreparationService('vi');

    const first = await dataSource.transaction((manager) =>
      vietnamesePreparation.prepare(manager, event),
    );
    const retry = await dataSource.transaction((manager) =>
      preparation.prepare(manager, event),
    );

    expect(first.locale).toBe(EmailDeliveryLocale.Vietnamese);
    expect(first.message.subject).toContain('đã được xác nhận');
    expect(retry.locale).toBe(EmailDeliveryLocale.Vietnamese);
    expect(retry.message.subject).toContain('đã được xác nhận');
  });

  it('names the room a change moved away from and never its internal id', async () => {
    const ownerUserId = await insertOwner('ACTIVE', 'moved@hotel.test');
    const beforeRoomId = await insertRoom('B-202', '90210066');
    const afterRoomId = await insertRoom('A-201', '90210077');
    const event = await insertChangedEvent(
      ownerUserId,
      beforeRoomId,
      afterRoomId,
    );

    const prepared = await dataSource.transaction((manager) =>
      preparation.prepare(manager, event),
    );

    expect(prepared.message.text).toContain('Previous room: B-202');
    // The room number is read from the database because the Phase 4 payload records
    // only an internal id, and internal ids are not published to a recipient.
    for (const part of [
      prepared.message.subject,
      prepared.message.text,
      prepared.message.html,
    ]) {
      expect(part).not.toContain(beforeRoomId);
      expect(part).not.toContain(afterRoomId);
    }
  });

  it('refuses a change whose previous room can no longer be read', async () => {
    const ownerUserId = await insertOwner('ACTIVE', 'missing-room@hotel.test');
    const afterRoomId = await insertRoom('A-201', '90210077');
    const event = await insertChangedEvent(
      ownerUserId,
      // A room id that never existed: preparation must fail with a stable code
      // rather than render a message naming nothing.
      '99999999',
      afterRoomId,
    );

    await expect(
      dataSource.transaction((manager) => preparation.prepare(manager, event)),
    ).rejects.toMatchObject<Partial<DeliveryPreparationError>>({
      code: deliveryPreparationErrorCodes.roomNotFound,
    });
  });

  it('requires the caller to own a transaction before locking a delivery snapshot', async () => {
    const ownerUserId = await insertOwner('ACTIVE', 'transaction@hotel.test');
    const event = await insertEvent(ownerUserId, 'booking.confirmed');

    await expect(
      preparation.prepare(dataSource.manager, event),
    ).rejects.toMatchObject<Partial<DeliveryPreparationError>>({
      code: deliveryPreparationErrorCodes.transactionRequired,
    });
  });

  function createPreparationService(
    locale: 'en' | 'vi',
  ): DeliveryPreparationService {
    const configuration = createNotificationsConfiguration(
      validateEnvironment({ MAIL_DEFAULT_LOCALE: locale }),
    );
    return new DeliveryPreparationService(
      new EmailTemplateService(configuration),
    );
  }

  async function insertOwner(
    status: 'ACTIVE' | 'INACTIVE',
    email: string,
  ): Promise<string> {
    await dataSource.query(
      `INSERT INTO users (email, display_name, role, status, email_verified_at)
       VALUES (?, 'Booking owner', 'USER', ?, NOW(6))`,
      [email, status],
    );
    const [owner] = await dataSource.query<Array<{ id: string }>>(
      'SELECT id FROM users WHERE email = ?',
      [email],
    );
    return String(owner.id);
  }

  // The id is explicit and long: an auto-increment `1` appears inside the booking
  // ULID and the dates, so "no internal id reached the message" would pass or fail
  // by coincidence rather than by behaviour.
  async function insertRoom(roomNumber: string, id: string): Promise<string> {
    await dataSource.query(
      `INSERT IGNORE INTO room_types (name) VALUES ('Notification fixture')`,
    );
    const [roomType] = await dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM room_types WHERE name = 'Notification fixture'`,
    );
    await dataSource.query(
      `INSERT INTO rooms (id, room_type_id, room_number, bed_count, base_price_amount, currency, status)
       VALUES (?, ?, ?, 2, 3000000, 'VND', 'ACTIVE')`,
      [id, roomType.id, roomNumber],
    );
    return id;
  }

  async function insertChangedEvent(
    ownerUserId: string,
    beforeRoomId: string,
    afterRoomId: string,
  ): Promise<Pick<OutboxEvent, 'id' | 'eventType' | 'payload'>> {
    const id = randomUUID();
    const base = notificationPayload(ownerUserId, 'booking.confirmed');
    const payload = {
      ...base,
      booking: {
        ...base.booking,
        room: { id: afterRoomId, roomNumber: 'A-201' },
        status: BookingStatus.Confirmed,
        reason: 'Guest requested a quieter room.',
      },
      before: {
        roomId: beforeRoomId,
        checkIn: '2026-09-20',
        checkOut: '2026-09-22',
      },
      after: {
        roomId: afterRoomId,
        checkIn: '2026-10-01',
        checkOut: '2026-10-03',
      },
    };
    await dataSource.getRepository(OutboxEvent).insert({
      id,
      eventType: 'booking.changed',
      payload,
      availableAt: new Date(),
      status: OutboxEventStatus.Pending,
      idempotencyKey: `booking.changed:${payload.bookingId}:2`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
      lastErrorCode: null,
      failedAt: null,
    });
    return { id, eventType: 'booking.changed', payload };
  }

  async function insertEvent(
    ownerUserId: string,
    eventType: 'booking.confirmed' | 'booking.rejected',
  ): Promise<Pick<OutboxEvent, 'id' | 'eventType' | 'payload'>> {
    const id = randomUUID();
    const payload = notificationPayload(ownerUserId, eventType);
    await dataSource.getRepository(OutboxEvent).insert({
      id,
      eventType,
      payload,
      availableAt: new Date(),
      status: OutboxEventStatus.Pending,
      idempotencyKey: `${eventType}:${payload.bookingId}:2`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
      lastErrorCode: null,
      failedAt: null,
    });
    return { id, eventType, payload };
  }
});

function notificationPayload(
  ownerUserId: string,
  eventType: 'booking.confirmed' | 'booking.rejected',
) {
  const rejected = eventType === 'booking.rejected';
  return {
    schemaVersion: 1,
    bookingId: '01K5ABCDEF0123456789ABCDEF',
    ownerUserId,
    bookingVersion: 2,
    booking: {
      room: { id: '7', roomNumber: 'A-201' },
      checkIn: '2026-10-01',
      checkOut: '2026-10-03',
      status: rejected ? BookingStatus.Rejected : BookingStatus.Confirmed,
      price: { amount: 3_000_000, currency: 'VND' },
      ...(rejected ? { reason: 'Dates are unavailable.' } : {}),
    },
  };
}
