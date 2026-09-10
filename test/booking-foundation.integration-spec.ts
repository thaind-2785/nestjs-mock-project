import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import mysql from 'mysql2/promise';
import { DataSource, EntityManager, getMetadataArgsStorage } from 'typeorm';
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
import { BookingsService } from '../src/bookings/bookings.service';
import { BookingCreateResponse } from '../src/bookings/booking-create.types';
import { createBookingsConfiguration } from '../src/config/bookings.config';
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
import { lockRoom } from '../src/rooms/room-lock';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';

jest.setTimeout(30_000);

const fixtureDates = bookingFixtureDates();

describe('Phase 4 booking foundation persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let bookings: BookingsService;

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
    bookings = new BookingsService(
      dataSource,
      createBookingsConfiguration(environment),
    );
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
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
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
      idempotencyKey: 'booking-foundation-pending',
      requestFingerprint: 'a'.repeat(64),
      status: IdempotencyKeyStatus.Pending,
      responseStatus: null,
      responseBody: null,
      expiresAt: fixtureDates.expiresAt,
    });
    const outbox = await dataSource.getRepository(OutboxEvent).save({
      id: randomUUID(),
      eventType: 'booking.confirmed',
      payload: { schemaVersion: 1, bookingId: booking.publicId },
      availableAt: fixtureDates.expiresAt,
      status: OutboxEventStatus.Pending,
      idempotencyKey: `booking.confirmed:${booking.publicId}:2`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    });

    expect(booking.checkIn).toBe(fixtureDates.checkIn);
    expect(booking.checkOut).toBe(fixtureDates.checkOut);
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
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
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
        checkIn: fixtureDates.checkOut,
        checkOut: fixtureDates.checkOut,
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
        expiresAt: fixtureDates.expiresAt,
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

  it('creates one pending booking atomically and replays an identical request', async () => {
    const { user, roomTime } = await createBookingGraph();
    const input = {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    };

    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    let created: BookingCreateResponse;
    let replayed: BookingCreateResponse;
    try {
      created = await bookings.create(
        user.id,
        'booking-create-retry-key',
        input,
        'request-create',
      );
      replayed = await bookings.create(
        user.id,
        'booking-create-retry-key',
        input,
        'request-replay',
      );
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'booking_created',
          requestId: 'request-create',
          operation: 'BOOKING_CREATE',
          actorType: 'USER',
          publicBookingId: created.id,
          result: 'created',
        }),
      );
    } finally {
      log.mockRestore();
    }

    expect(created).toMatchObject({
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
      nights: 3,
      status: 'PENDING',
      price: { amount: 4_500_000, currency: 'VND' },
    });
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(replayed).toEqual(created);
    expect(await dataSource.getRepository(Booking).count()).toBe(1);
    expect(await dataSource.getRepository(BookingStatusHistory).count()).toBe(
      1,
    );

    const idempotency = await dataSource
      .getRepository(IdempotencyKey)
      .findOneByOrFail({
        actorUserId: user.id,
        operation: 'BOOKING_CREATE',
        idempotencyKey: 'booking-create-retry-key',
      });
    expect(idempotency.status).toBe(IdempotencyKeyStatus.Completed);
    expect(idempotency.responseStatus).toBe(201);
    expect(idempotency.responseBody).toEqual(created);

    await expect(
      bookings.create(user.id, 'booking-create-retry-key', {
        ...input,
        checkOut: fixtureDates.checkOutDifferent,
      }),
    ).rejects.toMatchObject({
      errorCode: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await dataSource.getRepository(Booking).count()).toBe(1);
    expect(await dataSource.getRepository(BookingStatusHistory).count()).toBe(
      1,
    );
  });

  it('projects only the room-type fields returned by booking creation', async () => {
    const { user, roomTime } = await createBookingGraph();
    const queries: string[] = [];
    const captured = jest
      .spyOn(dataSource.logger, 'logQuery')
      .mockImplementation((sql) => queries.push(sql));

    try {
      await bookings.create(user.id, 'booking-create-room-type-select', {
        roomId: roomTime.roomId,
        checkIn: fixtureDates.checkIn,
        checkOut: fixtureDates.checkOut,
      });
    } finally {
      captured.mockRestore();
    }

    const roomTypeRead = queries.find((sql) =>
      /FROM `room_types` `RoomType`/.test(sql),
    );
    expect(roomTypeRead).toBeDefined();
    const projection = roomTypeRead?.slice(0, roomTypeRead.search(/\sFROM\s/i));
    expect(projection).toContain('`RoomType`.`id`');
    expect(projection).toContain('`RoomType`.`name`');
    for (const nonResponseColumn of [
      'description',
      'created_at',
      'updated_at',
    ]) {
      expect(projection).not.toContain(nonResponseColumn);
    }
  });

  it('serializes distinct idempotency claims at the shared room lock', async () => {
    const { user, roomTime } = await createBookingGraph();
    const mutation = dataSource.createQueryRunner();
    await mutation.connect();
    await mutation.startTransaction();

    try {
      await lockRoom(mutation.manager, roomTime.roomId);
      const queries = jest.spyOn(dataSource.logger, 'logQuery');
      const input = {
        roomId: roomTime.roomId,
        checkIn: fixtureDates.checkIn,
        checkOut: fixtureDates.checkOut,
      };
      const first = bookings.create(
        user.id,
        'booking-create-concurrent-one',
        input,
      );
      const second = bookings.create(
        user.id,
        'booking-create-concurrent-two',
        input,
      );

      await waitForQueryCount(queries, /INSERT INTO idempotency_keys/i, 2);
      expect(
        queries.mock.calls.filter(([sql]) => /FROM `room_times` /i.test(sql)),
      ).toHaveLength(0);
      await mutation.commitTransaction();

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(await dataSource.getRepository(Booking).count()).toBe(2);
      expect(await dataSource.getRepository(IdempotencyKey).count()).toBe(2);
    } finally {
      if (mutation.isTransactionActive) await mutation.rollbackTransaction();
      await mutation.release();
      jest.restoreAllMocks();
    }
  });

  it('rolls back the idempotency claim when no active window contains the stay', async () => {
    const { user, roomTime } = await createBookingGraph();

    await expect(
      bookings.create(user.id, 'booking-create-no-window', {
        roomId: roomTime.roomId,
        checkIn: fixtureDates.outsideCheckIn,
        checkOut: fixtureDates.outsideCheckOut,
      }),
    ).rejects.toMatchObject({
      errorCode: 'BOOKING_WINDOW_UNAVAILABLE',
    });

    expect(await dataSource.getRepository(Booking).count()).toBe(0);
    expect(await dataSource.getRepository(BookingStatusHistory).count()).toBe(
      0,
    );
    expect(await dataSource.getRepository(IdempotencyKey).count()).toBe(0);
  });

  it('lists, reads, and idempotently cancels only the booking owner records', async () => {
    const { user, roomTime } = await createBookingGraph();
    const created = await bookings.create(user.id, 'booking-user-cancel', {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    });

    await expect(bookings.getOwn('999999', created.id)).rejects.toMatchObject({
      errorCode: 'BOOKING_NOT_FOUND',
    });
    await expect(
      bookings.listOwn(user.id, {
        page: 1,
        pageSize: 20,
        status: BookingStatus.Pending,
      }),
    ).resolves.toMatchObject({ total: 1, items: [{ id: created.id }] });

    const cancelled = await bookings.cancelOwn(user.id, created.id);
    const replayed = await bookings.cancelOwn(user.id, created.id);
    expect(cancelled.status).toBe(BookingStatus.CancelledByUser);
    expect(replayed).toEqual(cancelled);
    expect(cancelled.history).toHaveLength(2);
    expect(cancelled.history.map((entry) => entry.toStatus)).toEqual([
      BookingStatus.Pending,
      BookingStatus.CancelledByUser,
    ]);
    expect(cancelled.history[0]).toMatchObject({
      actorType: BookingActorType.User,
      actor: { id: user.id, displayName: user.displayName },
    });
    await expect(
      bookings.cancelOwn('999999', created.id),
    ).rejects.toMatchObject({
      errorCode: 'BOOKING_NOT_FOUND',
    });
  });

  it('logs sanitized user-cancellation outcomes for apply, replay, and conflict', async () => {
    const { user, roomTime } = await createBookingGraph();
    const cancellable = await bookings.create(user.id, 'booking-cancel-log', {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    });
    const conflicting = await bookings.create(
      user.id,
      'booking-cancel-log-conflict',
      {
        roomId: roomTime.roomId,
        checkIn: fixtureDates.checkIn,
        checkOut: fixtureDates.checkOut,
      },
    );
    await dataSource
      .getRepository(Booking)
      .update(
        { publicId: conflicting.id },
        { status: BookingStatus.Confirmed },
      );

    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await bookings.cancelOwn(user.id, cancellable.id, 'request-cancel-apply');
      await bookings.cancelOwn(
        user.id,
        cancellable.id,
        'request-cancel-replay',
      );
      await expect(
        bookings.cancelOwn(user.id, conflicting.id, 'request-cancel-conflict'),
      ).rejects.toMatchObject({ errorCode: 'BOOKING_STATUS_CONFLICT' });

      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith({
        event: 'booking_cancelled_by_user',
        requestId: 'request-cancel-apply',
        operation: 'BOOKING_CANCEL',
        actorType: BookingActorType.User,
        publicBookingId: cancellable.id,
        result: 'cancelled',
      });
      expect(log).toHaveBeenCalledWith({
        event: 'booking_cancel_replayed',
        requestId: 'request-cancel-replay',
        operation: 'BOOKING_CANCEL',
        actorType: BookingActorType.User,
        publicBookingId: cancellable.id,
        result: 'replayed',
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({
        event: 'booking_cancel_conflict',
        requestId: 'request-cancel-conflict',
        operation: 'BOOKING_CANCEL',
        actorType: BookingActorType.User,
        result: 'conflict',
        errorCode: 'BOOKING_STATUS_CONFLICT',
      });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('applies half-open date overlap filters and stable pagination to the owner history', async () => {
    const { user, roomTime } = await createBookingGraph();
    const first = await bookings.create(user.id, 'booking-list-first', {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    });
    const second = await bookings.create(user.id, 'booking-list-second', {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    });
    await dataSource.query(
      'UPDATE bookings SET created_at = ? WHERE public_id IN (?, ?)',
      ['2026-01-01 00:00:00.000000', first.id, second.id],
    );

    await expect(
      bookings.listOwn(user.id, {
        page: 1,
        pageSize: 20,
        from: fixtureDates.checkOut,
        to: fixtureDates.checkOutDifferent,
      }),
    ).resolves.toMatchObject({ total: 0, items: [] });
    await expect(
      bookings.listOwn(user.id, {
        page: 1,
        pageSize: 1,
        from: fixtureDates.checkIn,
        to: fixtureDates.checkOut,
      }),
    ).resolves.toMatchObject({
      total: 2,
      items: [{ id: second.id }],
    });
    await expect(
      bookings.listOwn(user.id, {
        page: 2,
        pageSize: 1,
      }),
    ).resolves.toMatchObject({ items: [{ id: first.id }] });
  });

  it('rejects non-pending cancellation and rolls back a failed history append', async () => {
    const { user, roomTime } = await createBookingGraph();
    const confirmed = await bookings.create(
      user.id,
      'booking-cancel-confirmed',
      {
        roomId: roomTime.roomId,
        checkIn: fixtureDates.checkIn,
        checkOut: fixtureDates.checkOut,
      },
    );
    await dataSource
      .getRepository(Booking)
      .update({ publicId: confirmed.id }, { status: BookingStatus.Confirmed });
    await expect(
      bookings.cancelOwn(user.id, confirmed.id),
    ).rejects.toMatchObject({
      errorCode: 'BOOKING_STATUS_CONFLICT',
    });
    expect(
      await dataSource.getRepository(BookingStatusHistory).countBy({
        bookingId: (
          await dataSource.getRepository(Booking).findOneByOrFail({
            publicId: confirmed.id,
          })
        ).id,
      }),
    ).toBe(1);

    const pending = await bookings.create(user.id, 'booking-cancel-rollback', {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    });
    const insert = jest
      .spyOn(EntityManager.prototype, 'insert')
      .mockRejectedValue(new Error('forced booking history append failure'));
    try {
      await expect(bookings.cancelOwn(user.id, pending.id)).rejects.toThrow(
        'forced booking history append failure',
      );
    } finally {
      insert.mockRestore();
    }
    expect(
      await dataSource.getRepository(Booking).findOneByOrFail({
        publicId: pending.id,
      }),
    ).toMatchObject({ status: BookingStatus.Pending });
    expect(
      await dataSource.getRepository(BookingStatusHistory).countBy({
        bookingId: (
          await dataSource.getRepository(Booking).findOneByOrFail({
            publicId: pending.id,
          })
        ).id,
      }),
    ).toBe(1);
  });

  it('projects only booking-history fields needed by the user response', async () => {
    const { user, roomTime } = await createBookingGraph();
    await bookings.create(user.id, 'booking-projection-shape', {
      roomId: roomTime.roomId,
      checkIn: fixtureDates.checkIn,
      checkOut: fixtureDates.checkOut,
    });
    const queries = jest.spyOn(dataSource.logger, 'logQuery');
    try {
      await bookings.listOwn(user.id, { page: 1, pageSize: 20 });
      const query = queries.mock.calls
        .map(([sql]) => sql)
        .find((sql) => /FROM `bookings` `booking`/i.test(sql));
      expect(query).toBeDefined();
      expect(query).toContain('`booking`.`public_id`');
      expect(query).toContain('`room`.`room_number`');
      expect(query).toContain('`roomType`.`name`');
      expect(query).not.toContain('`room`.`base_price_amount`');
      expect(query).not.toContain('`room`.`bed_count`');
      expect(query).not.toContain('`roomTime`.`available_from`');
      expect(query).not.toContain('`roomType`.`description`');
    } finally {
      queries.mockRestore();
    }
  });

  it('waits for a competing room-time deactivation, then observes its committed state', async () => {
    const { user, roomTime } = await createBookingGraph();
    const roomTimeRepository = dataSource.getRepository(RoomTime);
    const mutation = dataSource.createQueryRunner();
    await mutation.connect();
    await mutation.startTransaction();

    try {
      // Room-time mutations use the same physical-room-first order. Holding that
      // lock makes the create wait before it can resolve the active window.
      await lockRoom(mutation.manager, roomTime.roomId);
      const lockedWindow = await mutation.manager.findOneOrFail(RoomTime, {
        where: { id: roomTime.id, roomId: roomTime.roomId },
        lock: { mode: 'pessimistic_write' },
      });
      lockedWindow.status = RoomTimeStatus.Inactive;
      await mutation.manager.save(lockedWindow);

      const queries = jest.spyOn(dataSource.logger, 'logQuery');
      let createSettled = false;
      const create = bookings
        .create(user.id, 'booking-create-window-race', {
          roomId: roomTime.roomId,
          checkIn: fixtureDates.checkIn,
          checkOut: fixtureDates.checkOut,
        })
        .finally(() => {
          createSettled = true;
        });

      await waitForQuery(queries, /FROM `rooms` .*FOR UPDATE/i);
      expect(createSettled).toBe(false);
      expect(
        queries.mock.calls.some(([sql]) => /FROM `room_times` /i.test(sql)),
      ).toBe(false);
      await mutation.commitTransaction();

      await expect(create).rejects.toMatchObject({
        errorCode: 'BOOKING_WINDOW_UNAVAILABLE',
      });
      expect(
        queries.mock.calls.some(([sql]) =>
          /FROM `room_times` .*FOR UPDATE/i.test(sql),
        ),
      ).toBe(true);
      expect(
        await roomTimeRepository.findOneByOrFail({ id: roomTime.id }),
      ).toMatchObject({ status: RoomTimeStatus.Inactive });
      expect(await dataSource.getRepository(Booking).count()).toBe(0);
      expect(await dataSource.getRepository(BookingStatusHistory).count()).toBe(
        0,
      );
      expect(await dataSource.getRepository(IdempotencyKey).count()).toBe(0);
    } finally {
      if (mutation.isTransactionActive) await mutation.rollbackTransaction();
      await mutation.release();
      jest.restoreAllMocks();
    }
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
      availableFrom: fixtureDates.availableFrom,
      availableTo: fixtureDates.availableTo,
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

async function waitForQuery(
  queries: jest.SpiedFunction<DataSource['logger']['logQuery']>,
  pattern: RegExp,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (queries.mock.calls.some(([sql]) => pattern.test(sql))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected query matching ${pattern.source}`);
}

async function waitForQueryCount(
  queries: jest.SpiedFunction<DataSource['logger']['logQuery']>,
  pattern: RegExp,
  expectedCount: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const matches = queries.mock.calls.filter(([sql]) => pattern.test(sql));
    if (matches.length >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected ${expectedCount} queries matching ${pattern.source}`,
  );
}

function bookingFixtureDates(): {
  availableFrom: string;
  checkIn: string;
  checkOut: string;
  checkOutDifferent: string;
  availableTo: string;
  outsideCheckIn: string;
  outsideCheckOut: string;
  expiresAt: Date;
} {
  const dateAt = (offsetDays: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  };
  return {
    availableFrom: dateAt(14),
    checkIn: dateAt(21),
    checkOut: dateAt(24),
    checkOutDifferent: dateAt(25),
    availableTo: dateAt(60),
    outsideCheckIn: dateAt(61),
    outsideCheckOut: dateAt(63),
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}
