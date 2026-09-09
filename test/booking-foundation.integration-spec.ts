import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource, getMetadataArgsStorage } from 'typeorm';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import { BookingChangeHistory } from '../src/bookings/entities/booking-change-history.entity';
import { BookingStatusHistory } from '../src/bookings/entities/booking-status-history.entity';
import {
  BookingActorType,
  BookingStatus,
  IdempotencyKeyStatus,
  OutboxEventStatus,
} from '../src/bookings/entities/booking.enums';
import { Booking } from '../src/bookings/entities/booking.entity';
import { IdempotencyKey } from '../src/bookings/entities/idempotency-key.entity';
import { OutboxEvent } from '../src/bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { CreateAuthRbacSchema1788380000000 } from '../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from '../src/database/migrations/1788490000000-CreateRoomCatalogSchema';
import { CreateBookingCoreSchema1788580000000 } from '../src/database/migrations/1788580000000-CreateBookingCoreSchema';
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';

jest.setTimeout(30_000);

describe('Phase 4 booking foundation persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p4_t01_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Booking foundation integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities: [
            User,
            AuthIdentity,
            AuthSession,
            UserStatusHistory,
            UserRoleHistory,
            RoomType,
            Amenity,
            Room,
            RoomAmenity,
            RoomTime,
            Booking,
            BookingStatusHistory,
            BookingChangeHistory,
            IdempotencyKey,
            OutboxEvent,
          ],
          migrations: [
            CreateAuthRbacSchema1788380000000,
            CreateRoomCatalogSchema1788490000000,
            CreateBookingCoreSchema1788580000000,
          ],
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM outbox_events');
    await dataSource.query('DELETE FROM idempotency_keys');
    await dataSource.query('DELETE FROM booking_change_history');
    await dataSource.query('DELETE FROM booking_status_history');
    await dataSource.query('DELETE FROM bookings');
    await dataSource.query('DELETE FROM room_times');
    await dataSource.query('DELETE FROM room_amenities');
    await dataSource.query('DELETE FROM rooms');
    await dataSource.query('DELETE FROM amenities');
    await dataSource.query('DELETE FROM room_types');
    await dataSource.query('DELETE FROM user_role_history');
    await dataSource.query('DELETE FROM user_status_history');
    await dataSource.query('DELETE FROM auth_sessions');
    await dataSource.query('DELETE FROM auth_identities');
    await dataSource.query('DELETE FROM users');
  });

  it('creates all Phase 4 tables with synchronize disabled', async () => {
    expect(dataSource.options.synchronize).toBe(false);
    expectColumnUtc(Booking, 'checkIn');
    expectColumnUtc(Booking, 'checkOut');
    expectColumnUtc(BookingChangeHistory, 'fromCheckIn');
    expectColumnUtc(BookingChangeHistory, 'toCheckOut');
    expect(await phaseFourTables()).toEqual([
      'booking_change_history',
      'booking_status_history',
      'bookings',
      'idempotency_keys',
      'outbox_events',
    ]);
  });

  it('round-trips the booking graph, immutable history, idempotency, and pending outbox state', async () => {
    const { user, roomTime } = await createBookingGraph();
    const booking = await dataSource.getRepository(Booking).save({
      publicId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      userId: user.id,
      roomTimeId: roomTime.id,
      checkIn: '2026-10-01',
      checkOut: '2026-10-04',
      status: BookingStatus.Pending,
      priceAmount: '4500000',
      currency: 'VND',
      rejectionReason: null,
    });
    const statusHistory = await dataSource
      .getRepository(BookingStatusHistory)
      .save({
        bookingId: booking.id,
        fromStatus: null,
        toStatus: BookingStatus.Pending,
        actorType: BookingActorType.User,
        actorUserId: user.id,
        reason: null,
      });
    const idempotency = await dataSource.getRepository(IdempotencyKey).save({
      actorUserId: user.id,
      operation: 'BOOKING_CREATE',
      idempotencyKey: 'booking-create-2026-10-01',
      requestFingerprint: 'a'.repeat(64),
      status: IdempotencyKeyStatus.Pending,
      responseStatus: null,
      responseBody: null,
      expiresAt: new Date('2026-09-10T00:00:00.000Z'),
    });
    const outbox = await dataSource.getRepository(OutboxEvent).save({
      id: randomUUID(),
      eventType: 'booking.confirmed',
      payload: { schemaVersion: 1, bookingId: booking.publicId },
      availableAt: new Date('2026-09-09T00:00:00.000Z'),
      status: OutboxEventStatus.Pending,
      idempotencyKey: `booking.confirmed:${booking.publicId}:2`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    });

    expect(booking.checkIn).toBe('2026-10-01');
    expect(booking.checkOut).toBe('2026-10-04');
    expect(booking.version).toBe('1');
    expect(booking.createdAt).toBeInstanceOf(Date);
    expect(statusHistory.createdAt).toBeInstanceOf(Date);
    expect(idempotency.status).toBe(IdempotencyKeyStatus.Pending);
    expect(outbox.status).toBe(OutboxEventStatus.Pending);
  });

  it('enforces booking, idempotency, outbox, and history safeguards', async () => {
    const { user, roomTime } = await createBookingGraph();
    const bookingRepository = dataSource.getRepository(Booking);
    const booking = await bookingRepository.save({
      publicId: '01K4N8G4X8R0K1F2Q7V6S9T3AB',
      userId: user.id,
      roomTimeId: roomTime.id,
      checkIn: '2026-10-01',
      checkOut: '2026-10-04',
      status: BookingStatus.Pending,
      priceAmount: '4500000',
      currency: 'VND',
      rejectionReason: null,
    });

    await expect(
      bookingRepository.insert({
        publicId: '01K4N8G4X8R0K1F2Q7V6S9T3AC',
        userId: user.id,
        roomTimeId: roomTime.id,
        checkIn: '2026-10-04',
        checkOut: '2026-10-04',
        status: BookingStatus.Pending,
        priceAmount: '4500000',
        currency: 'VND',
        rejectionReason: null,
      }),
    ).rejects.toBeDefined();

    await expect(
      dataSource.getRepository(IdempotencyKey).insert({
        actorUserId: user.id,
        operation: 'BOOKING_CREATE',
        idempotencyKey: 'incomplete-response',
        requestFingerprint: 'b'.repeat(64),
        status: IdempotencyKeyStatus.Completed,
        responseStatus: null,
        responseBody: null,
        expiresAt: new Date('2026-09-10T00:00:00.000Z'),
      }),
    ).rejects.toBeDefined();

    await expect(
      dataSource.getRepository(OutboxEvent).insert({
        id: randomUUID(),
        eventType: 'booking.confirmed',
        payload: { schemaVersion: 1 },
        availableAt: new Date(),
        status: OutboxEventStatus.Pending,
        idempotencyKey: `booking.confirmed:${booking.publicId}:2`,
        lockedAt: new Date(),
        lockExpiresAt: new Date(Date.now() + 60_000),
        lockedBy: 'worker-1',
        processedAt: null,
        attempts: 1,
      }),
    ).rejects.toBeDefined();

    await dataSource.getRepository(BookingStatusHistory).insert({
      bookingId: booking.id,
      fromStatus: null,
      toStatus: BookingStatus.Pending,
      actorType: BookingActorType.User,
      actorUserId: user.id,
      reason: null,
    });
    await expect(bookingRepository.delete(booking.id)).rejects.toBeDefined();
  });

  it('reverts only the Phase 4 schema and reapplies it cleanly', async () => {
    await dataSource.undoLastMigration();
    expect(await phaseFourTables()).toEqual([]);

    await dataSource.runMigrations();
    expect(await phaseFourTables()).toEqual([
      'booking_change_history',
      'booking_status_history',
      'bookings',
      'idempotency_keys',
      'outbox_events',
    ]);
  });

  async function phaseFourTables(): Promise<string[]> {
    const tables = await dataSource.query<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.tables
       WHERE table_schema = DATABASE() AND TABLE_NAME IN
       ('bookings','booking_status_history','booking_change_history','idempotency_keys','outbox_events')
       ORDER BY TABLE_NAME`,
    );
    return tables.map((row) => row.TABLE_NAME);
  }

  function expectColumnUtc(
    entity: typeof Booking | typeof BookingChangeHistory,
    propertyName: string,
  ): void {
    const column = getMetadataArgsStorage().columns.find(
      (entry) => entry.target === entity && entry.propertyName === propertyName,
    );
    expect(column?.options.utc).toBe(true);
  }

  async function createBookingGraph(): Promise<{
    user: User;
    roomTime: RoomTime;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: 'booking-user@example.com',
      displayName: 'Booking User',
      role: UserRole.User,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    const roomType = await dataSource.getRepository(RoomType).save({
      name: 'Deluxe',
      description: 'Deluxe room',
    });
    const room = await dataSource.getRepository(Room).save({
      roomTypeId: roomType.id,
      roomNumber: 'A-201',
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: '1500000',
      currency: 'VND',
      status: RoomStatus.Active,
    });
    const roomTime = await dataSource.getRepository(RoomTime).save({
      roomId: room.id,
      availableFrom: '2026-10-01',
      availableTo: '2026-12-01',
      status: RoomTimeStatus.Active,
    });
    return { user, roomTime };
  }

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
});
