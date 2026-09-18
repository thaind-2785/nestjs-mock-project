import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import {
  createReportsConfiguration,
  type ReportsConfiguration,
} from '../src/config/reports.config';
import { reportsWorkerEntities } from '../src/reports/reports-worker.entities';
import { createTypeOrmOptions } from '../src/database/database.options';
import { RoomExportSnapshotRepository } from '../src/reports/room-export-snapshot.repository';
import { RoomStatus } from '../src/rooms/entities/room.enums';
import { applicationMigrations } from './fixtures/application-migrations';

jest.setTimeout(60_000);

describe('Phase 6 room export snapshot', () => {
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let dataSource: DataSource;
  let baseline: ReportsConfiguration;
  let writer: mysql.Connection;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p6_t04_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Export snapshot prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          // Exactly what `ReportsWorkerModule` registers, not every entity in the
          // application: a suite that registers more cannot notice one the worker is
          // missing, which is how `Room` reached production unregistered.
          entities: reportsWorkerEntities,
          migrations: applicationMigrations,
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    baseline = createReportsConfiguration(environment);
    writer = await mysql.createConnection({
      host: environment.MYSQL_HOST,
      port: environment.MYSQL_PORT,
      user: environment.MYSQL_USER,
      password: environment.MYSQL_PASSWORD,
      database: disposableDatabase,
    });
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM room_amenities');
    await dataSource.query('DELETE FROM rooms');
    await dataSource.query('DELETE FROM amenities');
    await dataSource.query('DELETE FROM room_types');
  });

  afterAll(async () => {
    if (writer) await writer.end();
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

  it('reads nothing as an empty snapshot rather than a failure', async () => {
    expect(await read({})).toEqual({ rows: [], characters: 0 });
  });

  it('projects the accepted columns in numeric room order', async () => {
    const typeId = await insertRoomType('Deluxe');
    const wifi = await insertAmenity('WIFI', 'Wi-Fi');
    const ac = await insertAmenity('AC', 'Air conditioning');
    await insertRoom(typeId, { roomNumber: 'B-2' });
    const first = await insertRoom(typeId, { roomNumber: 'A-1' });
    // Assigned in reverse so the ordering under test is SQL's, not insertion order.
    await assignAmenities(first, [wifi, ac]);

    const snapshot = await read({});

    // Numeric room ID ascending: `B-2` was created first and so has the lower id,
    // which a lexicographic sort by room number would get wrong.
    expect(snapshot.rows.map((row) => row.roomNumber)).toEqual(['B-2', 'A-1']);
    expect(snapshot.rows[1]).toEqual({
      id: first,
      roomNumber: 'A-1',
      roomTypeName: 'Deluxe',
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: '1500000',
      currency: 'VND',
      status: RoomStatus.Active,
      version: expect.any(String) as string,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
      // Sorted by code in SQL, not by assignment order or amenity id.
      amenities: [
        { code: 'AC', name: 'Air conditioning' },
        { code: 'WIFI', name: 'Wi-Fi' },
      ],
    });
  });

  it('applies the same filters the admin list applies', async () => {
    const deluxe = await insertRoomType('Deluxe');
    const suite = await insertRoomType('Suite');
    await insertRoom(deluxe, {
      roomNumber: 'A-1',
      bedCount: 2,
      viewCode: 'CITY',
    });
    await insertRoom(deluxe, {
      roomNumber: 'A-2',
      bedCount: 4,
      viewCode: 'SEA',
      status: RoomStatus.Inactive,
    });
    await insertRoom(suite, { roomNumber: 'B-1', bedCount: 2, viewCode: null });

    expect(await numbers({ status: RoomStatus.Active })).toEqual([
      'A-1',
      'B-1',
    ]);
    expect(await numbers({ beds: 4 })).toEqual(['A-2']);
    expect(await numbers({ view: 'CITY' })).toEqual(['A-1']);
    expect(await numbers({ roomTypeId: suite })).toEqual(['B-1']);
    // The search term spans room number and room type name, exactly as the list does.
    expect(await numbers({ query: 'a-' })).toEqual(['A-1', 'A-2']);
    expect(await numbers({ query: 'suite' })).toEqual(['B-1']);
    // `_` is a LIKE wildcard; a caller searching for it must not match every room.
    expect(await numbers({ query: 'A_1' })).toEqual([]);
  });

  it('pages without OFFSET and without repeating or dropping a room', async () => {
    const typeId = await insertRoomType('Deluxe');
    for (let index = 0; index < 25; index += 1) {
      await insertRoom(typeId, { roomNumber: `A-${index}` });
    }

    // A page size that divides the set unevenly, so the last page is partial.
    const snapshot = await read({}, (draft) => {
      draft.snapshot.queryPageSize = 7;
    });

    expect(snapshot.rows).toHaveLength(25);
    expect(new Set(snapshot.rows.map((row) => row.id)).size).toBe(25);
  });

  it('refuses one row past the accepted limit rather than truncating', async () => {
    const typeId = await insertRoomType('Deluxe');
    for (let index = 0; index < 4; index += 1) {
      await insertRoom(typeId, { roomNumber: `A-${index}` });
    }

    // Three fits exactly; the fourth is the one that must fail the job. A reader that
    // truncated would hand an administrator a complete-looking file that is not.
    await expect(
      read({}, (draft) => {
        draft.snapshot.maxRows = 3;
        draft.snapshot.queryPageSize = 2;
      }),
    ).rejects.toMatchObject({ errorCode: 'EXPORT_ROW_LIMIT_EXCEEDED' });

    const fitting = await read({}, (draft) => {
      draft.snapshot.maxRows = 4;
    });
    expect(fitting.rows).toHaveLength(4);
  });

  it('refuses a snapshot whose volume exceeds the character cap', async () => {
    // The bound the row count cannot express: few rows, each enormous.
    const typeId = await insertRoomType('Deluxe');
    const wide = await insertAmenity('W'.repeat(50), 'N'.repeat(100));
    for (let index = 0; index < 3; index += 1) {
      const room = await insertRoom(typeId, { roomNumber: `A-${index}` });
      await assignAmenities(room, [wide]);
    }

    await expect(
      read({}, (draft) => {
        draft.snapshot.maxSnapshotChars = 300;
      }),
    ).rejects.toMatchObject({ errorCode: 'EXPORT_SNAPSHOT_TOO_LARGE' });
  });

  it('counts the characters a workbook will actually hold', async () => {
    const typeId = await insertRoomType('Deluxe');
    const room = await insertRoom(typeId, { roomNumber: 'A-1' });
    await assignAmenities(room, [await insertAmenity('AC', 'Air')]);

    const snapshot = await read({});
    const row = snapshot.rows[0];
    const expected =
      row.id.length +
      'A-1'.length +
      'Deluxe'.length +
      'CITY'.length +
      '1500000'.length +
      'VND'.length +
      RoomStatus.Active.length +
      row.version.length +
      24 * 2 +
      ('AC'.length + 'Air'.length + 5);

    expect(snapshot.characters).toBe(expected);
  });

  it('keeps one consistent view while rooms change underneath it', async () => {
    const typeId = await insertRoomType('Deluxe');
    for (let index = 0; index < 6; index += 1) {
      await insertRoom(typeId, { roomNumber: `A-${index}` });
    }

    const configuration = configurationWith((draft) => {
      draft.snapshot.queryPageSize = 2;
    });
    const repository = new RoomExportSnapshotRepository(
      dataSource,
      configuration,
    );
    // The update is committed from another connection after the first page is read and
    // before the second, which is the moment `REPEATABLE READ` exists for. Racing an
    // unsynchronised update against the read would prove nothing either way.
    type AmenityReader = (
      ...args: never[]
    ) => Promise<Map<string, { code: string; name: string }[]>>;
    const hooked = repository as unknown as { readAmenities: AmenityReader };
    const originalReadAmenities: AmenityReader = hooked.readAmenities.bind(
      repository,
    ) as AmenityReader;
    let interrupted = false;
    hooked.readAmenities = async (...args: never[]) => {
      const amenities = await originalReadAmenities(...args);
      if (!interrupted) {
        interrupted = true;
        await writer.query(
          "UPDATE rooms SET room_number = CONCAT('X-', id), status = 'INACTIVE'",
        );
      }
      return amenities;
    };

    const snapshot = await repository.read({});

    expect(interrupted).toBe(true);
    expect(snapshot.rows).toHaveLength(6);
    // Every page, including the ones read after the commit, describes the same instant.
    for (const row of snapshot.rows) {
      expect(row.roomNumber.startsWith('A-')).toBe(true);
      expect(row.status).toBe(RoomStatus.Active);
    }
    // And the change really did land, so this is isolation rather than a no-op.
    const [after]: Array<{ total: number }> = await dataSource.query(
      "SELECT COUNT(*) AS total FROM rooms WHERE room_number LIKE 'X-%'",
    );
    expect(Number(after.total)).toBe(6);
  });

  it('reads a page of rooms and their amenities in two statements', async () => {
    const typeId = await insertRoomType('Deluxe');
    const amenity = await insertAmenity('AC', 'Air');
    for (let index = 0; index < 10; index += 1) {
      const room = await insertRoom(typeId, { roomNumber: `A-${index}` });
      await assignAmenities(room, [amenity]);
    }

    const statements = countStatements();
    await read({}, (draft) => {
      draft.snapshot.queryPageSize = 10;
    });
    const observed = statements.stop();

    // One room page and one amenity set query, plus the session bound. Ten rooms must
    // not cost ten amenity reads, which is the shape this assertion exists to pin.
    expect(
      observed.filter((sql) => /FROM room_amenities/i.test(sql)),
    ).toHaveLength(1);
    expect(observed.filter((sql) => /FROM `rooms`/i.test(sql))).toHaveLength(2);
  });

  /**
   * Counts through TypeORM's own logger rather than by wrapping a query runner: the
   * builder and `manager.query` take different paths to the driver, and only the logger
   * sees both.
   */
  function countStatements(): { stop: () => string[] } {
    const observed: string[] = [];
    const previous = dataSource.logger;
    dataSource.logger = {
      logQuery: (query: string) => observed.push(query),
      logQueryError: () => undefined,
      logQuerySlow: () => undefined,
      logSchemaBuild: () => undefined,
      logMigration: () => undefined,
      log: () => undefined,
    };
    return {
      stop: () => {
        dataSource.logger = previous;
        return observed;
      },
    };
  }

  function configurationWith(
    mutate: (draft: ReportsConfiguration) => void,
  ): ReportsConfiguration {
    const configuration = createReportsConfiguration(
      validateEnvironment(process.env),
    );
    configuration.snapshot = { ...baseline.snapshot };
    mutate(configuration);
    return configuration;
  }

  function read(
    filters: Record<string, unknown>,
    mutate: (draft: ReportsConfiguration) => void = () => undefined,
  ) {
    return new RoomExportSnapshotRepository(
      dataSource,
      configurationWith(mutate),
    ).read(filters);
  }

  async function numbers(filters: Record<string, unknown>): Promise<string[]> {
    return (await read(filters)).rows.map((row) => row.roomNumber);
  }

  async function insertRoomType(name: string): Promise<string> {
    const result: { insertId: number } = await dataSource.query(
      'INSERT INTO room_types (name, description) VALUES (?, ?)',
      [name, `${name} rooms`],
    );
    return String(result.insertId);
  }

  async function insertAmenity(code: string, name: string): Promise<string> {
    const result: { insertId: number } = await dataSource.query(
      'INSERT INTO amenities (code, name) VALUES (?, ?)',
      [code, name],
    );
    return String(result.insertId);
  }

  async function insertRoom(
    roomTypeId: string,
    overrides: {
      roomNumber: string;
      bedCount?: number;
      viewCode?: string | null;
      status?: RoomStatus;
    },
  ): Promise<string> {
    const result: { insertId: number } = await dataSource.query(
      `INSERT INTO rooms
         (room_type_id, room_number, bed_count, view_code, base_price_amount, currency, status)
       VALUES (?, ?, ?, ?, 1500000, 'VND', ?)`,
      [
        roomTypeId,
        overrides.roomNumber,
        overrides.bedCount ?? 2,
        overrides.viewCode === undefined ? 'CITY' : overrides.viewCode,
        overrides.status ?? RoomStatus.Active,
      ],
    );
    return String(result.insertId);
  }

  async function assignAmenities(
    roomId: string,
    amenityIds: string[],
  ): Promise<void> {
    for (const amenityId of amenityIds) {
      await dataSource.query(
        'INSERT INTO room_amenities (room_id, amenity_id) VALUES (?, ?)',
        [roomId, amenityId],
      );
    }
  }
});
