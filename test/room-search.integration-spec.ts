import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { createTypeOrmOptions } from '../src/database/database.options';
import { CreateAuthRbacSchema1788380000000 } from '../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from '../src/database/migrations/1788490000000-CreateRoomCatalogSchema';
import { CreateBookingCoreSchema1788580000000 } from '../src/database/migrations/1788580000000-CreateBookingCoreSchema';
import { Booking } from '../src/bookings/entities/booking.entity';
import { BookingStatus } from '../src/bookings/entities/booking.enums';
import { Attachment } from '../src/files/entities/attachment.entity';
import { StorageCleanupTask } from '../src/files/entities/storage-cleanup-task.entity';
import { SearchRoomsQueryDto } from '../src/rooms/dto/public-room-query.dto';
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { ReferenceCatalogService } from '../src/rooms/reference-catalog.service';
import { resolveAmenityFilter } from '../src/rooms/room-search-policy';
import { RoomSearchService } from '../src/rooms/room-search.service';
import { UnusedRoomTimeUsageRepository } from './fixtures/room-time-usage';
import { RoomTimesService } from '../src/rooms/room-times.service';
import { RoomsService } from '../src/rooms/rooms.service';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';
import {
  createRoomImageFixture,
  RoomImageFixture,
} from './fixtures/room-images';

jest.setTimeout(30_000);

describe('Phase 3 public room search', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let catalog: ReferenceCatalogService;
  let imageFixture: RoomImageFixture;
  let rooms: RoomsService;
  let roomTimes: RoomTimesService;
  let search: RoomSearchService;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t04_${process.pid}_${randomUUID().replaceAll('-', '')}`;
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
        `Public room search integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
            Attachment,
            StorageCleanupTask,
            // Availability subtracts room-wide confirmed stays, so the search
            // query reads the booking table even in a rooms-only suite.
            Booking,
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
    const connection = new DatabaseConnectionService(dataSource);
    catalog = new ReferenceCatalogService(dataSource, connection);
    imageFixture = createRoomImageFixture(dataSource, connection, environment);
    rooms = new RoomsService(dataSource, connection, imageFixture.images);
    roomTimes = new RoomTimesService(
      dataSource,
      connection,
      new UnusedRoomTimeUsageRepository(),
    );
    search = new RoomSearchService(dataSource, connection, imageFixture.images);
  });

  beforeEach(async () => {
    for (const table of [
      'booking_status_history',
      'bookings',
      'room_times',
      'room_amenities',
      'rooms',
      'amenities',
      'room_types',
      'users',
    ]) {
      await dataSource.query(`DELETE FROM ${table}`);
    }
  });

  it('browses only active rooms and never claims availability without dates', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const active = await rooms.create(roomInput(type.id, [], 'A-201'));
    await rooms.create({
      ...roomInput(type.id, [], 'A-202'),
      status: RoomStatus.Inactive,
    });
    await rooms.create({
      ...roomInput(type.id, [], 'A-203'),
      status: RoomStatus.Maintenance,
    });

    const result = await search.search(query({}));
    expect(result).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(result.items).toMatchObject([
      {
        id: active.id,
        bedCount: 2,
        viewCode: 'CITY',
        basePriceAmount: 1_500_000,
        currency: 'VND',
        roomType: { id: type.id, name: 'Deluxe' },
      },
    ]);
    // Public payloads never expose the physical room number, the room status,
    // availability the caller did not ask for, or internal audit timestamps.
    expect(result.items[0]).not.toHaveProperty('roomNumber');
    expect(result.items[0]).not.toHaveProperty('status');
    expect(result.items[0]).not.toHaveProperty('available');
    expect(Object.keys(result.items[0].roomType).sort()).toEqual([
      'description',
      'id',
      'name',
    ]);
  });

  it('hydrates only the room and room-type columns published by the public mapper', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const room = await rooms.create(roomInput(type.id, [], 'A-201'));
    const queries: string[] = [];
    const captured = jest
      .spyOn(dataSource.logger, 'logQuery')
      .mockImplementation((sql) => queries.push(sql));

    try {
      await search.search(query({}));
      await search.get(room.id, {});
    } finally {
      captured.mockRestore();
    }

    const publicRoomReads = queries.filter((sql) =>
      /FROM `rooms` `(room|Room)`/.test(sql),
    );
    expect(publicRoomReads.length).toBeGreaterThanOrEqual(2);
    const projections = publicRoomReads
      .map((sql) => sql.slice(0, sql.search(/\sFROM\s/i)))
      .join('\n');
    expect(projections).toContain('bed_count');
    expect(projections).toContain('base_price_amount');
    for (const internalColumn of [
      'room_number',
      'status',
      'version',
      'created_at',
      'updated_at',
    ]) {
      expect(projections).not.toContain(internalColumn);
    }
  });

  it('applies all-of amenity semantics without duplicating rooms or inflating total', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const wifi = await catalog.createAmenity({ code: 'WIFI', name: 'Wi-Fi' });
    const pool = await catalog.createAmenity({ code: 'POOL', name: 'Pool' });
    const spa = await catalog.createAmenity({ code: 'SPA', name: 'Spa' });
    const both = await rooms.create(
      roomInput(type.id, [wifi.id, pool.id], 'A-201'),
    );
    await rooms.create(roomInput(type.id, [wifi.id], 'A-202'));
    await rooms.create(roomInput(type.id, [], 'A-203'));

    const matched = await search.search(query({ amenity: [wifi.id, pool.id] }));
    expect(matched.total).toBe(1);
    expect(matched.items.map((item) => item.id)).toEqual([both.id]);
    expect(matched.items[0].amenities.map((amenity) => amenity.code)).toEqual([
      'WIFI',
      'POOL',
    ]);

    // A repeated value must not lower the required match count.
    expect(
      (await search.search(query({ amenity: [wifi.id, wifi.id, pool.id] })))
        .total,
    ).toBe(1);
    expect(
      (await search.search(query({ amenity: [wifi.id, pool.id, spa.id] })))
        .total,
    ).toBe(0);
    expect((await search.search(query({ amenity: [wifi.id] }))).total).toBe(2);
    // Amenity IDs are decimal strings: ordering them lexicographically would
    // build a different query for the same requested set.
    expect(resolveAmenityFilter(['10', '9', '10'])).toEqual(['9', '10']);
  });

  it('filters by room type, beds, view, and price within one currency', async () => {
    const deluxe = await catalog.createRoomType({ name: 'Deluxe' });
    const suite = await catalog.createRoomType({ name: 'Suite' });
    const cheap = await rooms.create({
      ...roomInput(deluxe.id, [], 'A-201'),
      basePriceAmount: 1_000_000,
    });
    const expensive = await rooms.create({
      ...roomInput(deluxe.id, [], 'A-202'),
      basePriceAmount: 3_000_000,
      bedCount: 4,
      viewCode: 'SEA',
    });
    await rooms.create({
      ...roomInput(suite.id, [], 'A-203'),
      basePriceAmount: 1_000_000,
      currency: 'USD',
    });

    expect(
      (await search.search(query({ roomTypeId: suite.id }))).items.length,
    ).toBe(1);
    expect(
      (await search.search(query({ beds: 4 }))).items.map((item) => item.id),
    ).toEqual([expensive.id]);
    expect(
      (await search.search(query({ view: 'SEA' }))).items.map(
        (item) => item.id,
      ),
    ).toEqual([expensive.id]);
    // The DTO normalizes the catalog code at the boundary, so a lowercase or
    // padded filter matches the stored uppercase value.
    expect(
      (
        await search.search(
          plainToInstance(SearchRoomsQueryDto, { view: '  sea  ' }),
        )
      ).items.map((item) => item.id),
    ).toEqual([expensive.id]);
    // A blank value omits the filter rather than matching a blank view code.
    expect(
      (await search.search(plainToInstance(SearchRoomsQueryDto, { view: ' ' })))
        .total,
    ).toBe(3);
    expect(
      (
        await search.search(
          query({ minPrice: 900_000, maxPrice: 2_000_000, currency: 'VND' }),
        )
      ).items.map((item) => item.id),
    ).toEqual([cheap.id]);
    // Price bounds never cross currencies because Phase 3 does not convert.
    expect(
      (
        await search.search(
          query({ minPrice: 900_000, maxPrice: 2_000_000, currency: 'USD' }),
        )
      ).total,
    ).toBe(1);
  });

  it('returns a stay only when one active window contains it entirely', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const contained = await rooms.create(roomInput(type.id, [], 'A-201'));
    const adjacentOnly = await rooms.create(roomInput(type.id, [], 'A-202'));
    const inactiveWindow = await rooms.create(roomInput(type.id, [], 'A-203'));
    await roomTimes.create(contained.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Active,
    });
    // Two adjacent windows cover the stay together but neither contains it.
    await roomTimes.create(adjacentOnly.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-06',
      status: RoomTimeStatus.Active,
    });
    await roomTimes.create(adjacentOnly.id, {
      availableFrom: '2026-10-06',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Active,
    });
    await roomTimes.create(inactiveWindow.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Inactive,
    });

    const stay = { checkIn: '2026-10-05', checkOut: '2026-10-08' };
    const result = await search.search(query(stay));
    expect(result.total).toBe(1);
    expect(result.items).toMatchObject([{ id: contained.id, available: true }]);

    // Boundary stays are contained by the half-open window.
    expect(
      (
        await search.search(
          query({ checkIn: '2026-10-01', checkOut: '2026-10-20' }),
        )
      ).items.map((item) => item.id),
    ).toEqual([contained.id]);
    expect(
      (
        await search.search(
          query({ checkIn: '2026-09-30', checkOut: '2026-10-20' }),
        )
      ).total,
    ).toBe(0);
    expect(
      (
        await search.search(
          query({ checkIn: '2026-10-01', checkOut: '2026-10-21' }),
        )
      ).total,
    ).toBe(0);
  });

  it('paginates deterministically with a total from the same filters', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const wifi = await catalog.createAmenity({ code: 'WIFI', name: 'Wi-Fi' });
    const createdIds: string[] = [];
    for (const roomNumber of ['A-201', 'A-202', 'A-203']) {
      const room = await rooms.create(
        roomInput(type.id, [wifi.id], roomNumber),
      );
      createdIds.push(room.id);
    }
    await rooms.create(roomInput(type.id, [], 'A-204'));
    const ascending = [...createdIds].sort((a, b) => +a - +b);

    const first = await search.search(
      query({ amenity: [wifi.id], page: 1, pageSize: 2 }),
    );
    const second = await search.search(
      query({ amenity: [wifi.id], page: 2, pageSize: 2 }),
    );
    expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(second).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(first.items.map((item) => item.id)).toEqual(ascending.slice(0, 2));
    expect(second.items.map((item) => item.id)).toEqual(ascending.slice(2));
  });

  it('reads one public room and answers availability per stay', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const wifi = await catalog.createAmenity({ code: 'WIFI', name: 'Wi-Fi' });
    const room = await rooms.create(roomInput(type.id, [wifi.id], 'A-201'));
    await roomTimes.create(room.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Active,
    });
    const hidden = await rooms.create({
      ...roomInput(type.id, [], 'A-202'),
      status: RoomStatus.Maintenance,
    });

    const detail = await search.get(room.id, {});
    expect(detail).toMatchObject({
      id: room.id,
      amenities: [{ code: 'WIFI' }],
    });
    expect(detail).not.toHaveProperty('available');
    expect(
      await search.get(room.id, {
        checkIn: '2026-10-05',
        checkOut: '2026-10-08',
      }),
    ).toMatchObject({ available: true });
    expect(
      await search.get(room.id, {
        checkIn: '2026-10-19',
        checkOut: '2026-10-21',
      }),
    ).toMatchObject({ available: false });
    await expect(search.get(hidden.id, {})).rejects.toMatchObject({
      errorCode: 'ROOM_NOT_FOUND',
    });
    await expect(search.get('987654321', {})).rejects.toMatchObject({
      errorCode: 'ROOM_NOT_FOUND',
    });
  });

  it('excludes a room whose confirmed stay overlaps, whatever window it references', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const booked = await rooms.create(roomInput(type.id, [], 'A-201'));
    const free = await rooms.create(roomInput(type.id, [], 'A-202'));
    const bookable = await roomTimes.create(booked.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Active,
    });
    await roomTimes.create(free.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Active,
    });
    // The confirmed stay references a since-deactivated window of the booked
    // room, so a window-scoped exclusion would still advertise the room.
    const legacy = await roomTimes.create(booked.id, {
      availableFrom: '2026-09-01',
      availableTo: '2026-09-30',
      status: RoomTimeStatus.Inactive,
    });
    expect(legacy.id).not.toBe(bookable.id);
    await createConfirmedStay(legacy.id, '2026-10-05', '2026-10-08');

    const stay = { checkIn: '2026-10-06', checkOut: '2026-10-07' };
    expect((await search.search(query(stay))).items).toMatchObject([
      { id: free.id, available: true },
    ]);
    expect(await search.get(booked.id, stay)).toMatchObject({
      available: false,
    });
    expect(await search.get(free.id, stay)).toMatchObject({ available: true });
  });

  it('lets adjacent stays share a boundary and never blocks on unconfirmed status', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const adjacent = await rooms.create(roomInput(type.id, [], 'A-201'));
    const pending = await rooms.create(roomInput(type.id, [], 'A-202'));
    const terminal = await rooms.create(roomInput(type.id, [], 'A-203'));
    const windows = new Map<string, string>();
    for (const room of [adjacent, pending, terminal]) {
      const window = await roomTimes.create(room.id, {
        availableFrom: '2026-10-01',
        availableTo: '2026-10-20',
        status: RoomTimeStatus.Active,
      });
      windows.set(room.id, window.id);
    }
    // Checkout is exclusive, so this stay ends exactly when the query begins.
    await createConfirmedStay(
      windows.get(adjacent.id)!,
      '2026-10-03',
      '2026-10-06',
    );
    await createStay(
      windows.get(pending.id)!,
      '2026-10-06',
      '2026-10-09',
      BookingStatus.Pending,
    );
    await createStay(
      windows.get(terminal.id)!,
      '2026-10-06',
      '2026-10-09',
      BookingStatus.CancelledByAdmin,
    );

    // Two overlapping pending requests may coexist, and neither withdraws the
    // room from public availability until one of them is confirmed.
    await createStay(
      windows.get(pending.id)!,
      '2026-10-07',
      '2026-10-10',
      BookingStatus.Pending,
    );

    const stay = { checkIn: '2026-10-06', checkOut: '2026-10-09' };
    expect(
      (await search.search(query(stay))).items.map((item) => item.id).sort(),
    ).toEqual([adjacent.id, pending.id, terminal.id].sort());
    for (const room of [adjacent, pending, terminal]) {
      expect(await search.get(room.id, stay)).toMatchObject({
        available: true,
      });
    }
  });

  it('reads availability through the room-wide confirmed index', async () => {
    const type = await catalog.createRoomType({ name: 'Deluxe' });
    const room = await rooms.create(roomInput(type.id, [], 'A-201'));
    const window = await roomTimes.create(room.id, {
      availableFrom: '2026-10-01',
      availableTo: '2026-10-20',
      status: RoomTimeStatus.Active,
    });
    await createConfirmedStay(window.id, '2026-10-05', '2026-10-08');
    const queries = jest.spyOn(dataSource.logger, 'logQuery');
    let executed: [string, unknown[] | undefined] | undefined;
    try {
      await search.search(
        query({ checkIn: '2026-10-06', checkOut: '2026-10-07' }),
      );
      const call = queries.mock.calls.find(([sql]) =>
        /FROM `rooms` `room`/i.test(sql),
      );
      // Explaining the emitted statement with its own bound parameters keeps the
      // plan evidence tied to the query the service actually runs.
      if (call) executed = [call[0], call[1]];
    } finally {
      queries.mockRestore();
    }
    expect(executed).toBeDefined();
    const [searchSql, searchParameters] = executed!;
    // The exclusion must be room-wide: it correlates the blocking stay's window
    // to the candidate room, not to the window the containment check matched.
    expect(searchSql).toMatch(/NOT EXISTS/i);
    expect(searchSql).toContain('`blockingWindow`.`room_id` = `room`.`id`');

    const explained: { EXPLAIN: string }[] = await dataSource.query(
      `EXPLAIN FORMAT=JSON ${searchSql}`,
      searchParameters,
    );
    const plans = collectTablePlans(JSON.parse(explained[0].EXPLAIN));
    // Query-plan evidence for PLAN-007: the overlap probe rides the existing
    // room-time composite index, so no availability index is added.
    expect(plans.get('blocking')).toMatchObject({
      key: 'idx_bookings_room_time_status_check_in_out',
    });
    expect(plans.get('blocking')?.access_type).not.toBe('ALL');
    expect(plans.get('blockingWindow')).toMatchObject({ key: 'PRIMARY' });
  });

  async function createConfirmedStay(
    roomTimeId: string,
    checkIn: string,
    checkOut: string,
  ): Promise<void> {
    await createStay(roomTimeId, checkIn, checkOut, BookingStatus.Confirmed);
  }

  async function createStay(
    roomTimeId: string,
    checkIn: string,
    checkOut: string,
    status: BookingStatus,
  ): Promise<void> {
    const owner = await dataSource.getRepository(User).save({
      email: `search-owner-${randomUUID()}@example.com`,
      displayName: 'Search Owner',
      role: UserRole.User,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    await dataSource.getRepository(Booking).save({
      publicId: randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase(),
      userId: owner.id,
      roomTimeId,
      checkIn,
      checkOut,
      status,
      priceAmount: '4500000',
      currency: 'VND',
      rejectionReason: null,
    });
  }

  interface TablePlan {
    table_name: string;
    access_type: string;
    key?: string;
  }

  /** `EXPLAIN FORMAT=JSON` nests each table plan at an unpredictable depth. */
  function collectTablePlans(node: unknown): Map<string, TablePlan> {
    const plans = new Map<string, TablePlan>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.table_name === 'string') {
        plans.set(record.table_name, record as unknown as TablePlan);
      }
      Object.values(record).forEach(visit);
    };
    visit(node);
    return plans;
  }

  function query(overrides: Partial<SearchRoomsQueryDto>): SearchRoomsQueryDto {
    return Object.assign(new SearchRoomsQueryDto(), overrides);
  }

  function roomInput(
    roomTypeId: string,
    amenityIds: string[],
    roomNumber: string,
  ) {
    return {
      roomNumber,
      roomTypeId,
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: 1_500_000,
      currency: 'VND',
      status: RoomStatus.Active,
      amenityIds,
    };
  }

  afterAll(async () => {
    imageFixture?.destroy();
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
