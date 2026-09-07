import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GOOGLE_OAUTH_CLIENT } from '../src/auth/auth.tokens';
import { GoogleIdentityClaims } from '../src/auth/auth.types';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import {
  GoogleAuthorizationRequest,
  GoogleCodeExchange,
  GoogleOAuthClientContract,
} from '../src/auth/google/google-oauth.client';
import { configureApplication } from '../src/bootstrap';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { CreateAuthRbacSchema1788380000000 } from '../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from '../src/database/migrations/1788490000000-CreateRoomCatalogSchema';
import { Attachment } from '../src/files/entities/attachment.entity';
import { StorageCleanupTask } from '../src/files/entities/storage-cleanup-task.entity';
import { maxPageNumber } from '../src/rooms/dto/pagination-query.dto';
import { maxAmenityFilterCount } from '../src/rooms/room-search-policy';
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';

jest.setTimeout(30_000);

interface PublicRoomPayload {
  id: string;
  bedCount: number;
  viewCode: string | null;
  basePriceAmount: number;
  currency: string;
  roomType: { id: string; name: string };
  amenities: { id: string; code: string }[];
  available?: boolean;
}

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  createAuthorizationUrl(input: GoogleAuthorizationRequest): string {
    const url = new URL('https://accounts.google.test/authorize');
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  exchangeAndVerify(input: GoogleCodeExchange): Promise<GoogleIdentityClaims> {
    void input;
    return Promise.reject(new Error('Public catalog E2E never authenticates'));
  }
}

describe('Phase 3 public room API (e2e)', () => {
  let app: INestApplication<App>;
  let seed: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let activeRoomId: string;
  let secondRoomId: string;
  let hiddenRoomId: string;
  let wifiId: string;
  let poolId: string;
  const savedEnvironment = new Map<string, string | undefined>();
  const environmentKeys = [
    'NODE_ENV',
    'MYSQL_DATABASE',
    'GOOGLE_AUTH_ENABLED',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'AUTH_REDIS_KEY_PREFIX',
  ];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    for (const key of environmentKeys)
      savedEnvironment.set(key, process.env[key]);
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t04_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:3000/api/v1/auth/google/callback';
    process.env.AUTH_REDIS_KEY_PREFIX = `hotel:p3-t04:${process.pid}:${randomUUID().replaceAll('-', '')}`;

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
        `Public room E2E prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    seed = new DataSource(
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
          ],
          migrations: [
            CreateAuthRbacSchema1788380000000,
            CreateRoomCatalogSchema1788490000000,
          ],
        },
      ),
    );
    await seed.initialize();
    await seed.runMigrations();
    await seedCatalog();

    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH_CLIENT)
      .useValue(new FakeGoogleOAuthClient())
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, {
      swaggerEnabled: true,
      requestLogger: { log: jest.fn() },
    });
    await app.init();
  });

  it('serves the public catalog to guests with filters, availability, and localized errors', async () => {
    const guest = request(app.getHttpServer());

    // No token: the public catalog is reachable while admin routes are not.
    await guest.get('/api/v1/admin/rooms').expect(401);
    const browse = await guest.get('/api/v1/rooms').expect(200);
    expect(browse.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(
      (browse.body as { items: { id: string }[] }).items.map((item) => item.id),
    ).toEqual([activeRoomId, secondRoomId]);
    const [firstItem] = (browse.body as { items: PublicRoomPayload[] }).items;
    expect(firstItem).toMatchObject({
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: 1_500_000,
      currency: 'VND',
      roomType: { name: 'Deluxe' },
      amenities: [{ code: 'WIFI' }, { code: 'POOL' }],
    });
    expect(firstItem).not.toHaveProperty('roomNumber');
    expect(firstItem).not.toHaveProperty('available');
    expect(firstItem).not.toHaveProperty('status');
    // Nested catalog objects are public shapes, not the admin DTOs, so no audit
    // timestamp reaches an anonymous caller.
    expect(Object.keys(firstItem.roomType).sort()).toEqual([
      'description',
      'id',
      'name',
    ]);
    for (const amenity of firstItem.amenities) {
      expect(Object.keys(amenity).sort()).toEqual(['code', 'id', 'name']);
    }

    // Repeated amenity parameters require every requested amenity.
    await guest
      .get('/api/v1/rooms')
      .query(`amenity=${wifiId}&amenity=${poolId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ total: 1 });
        expect((response.body as { items: { id: string }[] }).items[0].id).toBe(
          activeRoomId,
        );
      });
    await guest
      .get('/api/v1/rooms')
      .query(`amenity=${wifiId}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ total: 2 });
      });

    // A contained stay is available; a stay crossing the window edge is not.
    await guest
      .get('/api/v1/rooms')
      .query({ checkIn: '2026-10-05', checkOut: '2026-10-08' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          total: 1,
          items: [{ id: activeRoomId, available: true }],
        });
      });
    await guest
      .get('/api/v1/rooms')
      .query({ checkIn: '2026-10-19', checkOut: '2026-10-21' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ total: 0, items: [] });
      });

    await guest
      .get('/api/v1/rooms')
      .query({ checkIn: '2026-10-05' })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'DATE_RANGE_INCOMPLETE',
        });
      });
    await guest
      .get('/api/v1/rooms')
      .query({ checkIn: '2026-10-08', checkOut: '2026-10-08' })
      .set('Accept-Language', 'vi')
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'STAY_RANGE_INVALID',
          message: 'Ngày checkOut phải sau ngày checkIn.',
        });
      });
    // Each rejection must name the filter that failed, so none of these can
    // pass for an unrelated reason such as an unwhitelisted parameter.
    for (const [query, expected] of [
      [
        { checkIn: '2026-02-30', checkOut: '2026-03-10' },
        { field: 'checkIn', codes: ['isDateString'] },
      ],
      [{ minPrice: 1_000_000 }, { field: 'currency' }],
      [{ pageSize: 101 }, { field: 'pageSize', codes: ['max'] }],
      [
        {
          minPrice: 2_000_000,
          maxPrice: 1_000_000,
          currency: 'VND',
        },
        { field: 'maxPrice', codes: ['priceRangeInverted'] },
      ],
    ] as const) {
      await guest
        .get('/api/v1/rooms')
        .query(query)
        .expect(400)
        .expect((response) => {
          expect(response.body).toMatchObject({
            code: 'VALIDATION_FAILED',
            details: { errors: [expect.objectContaining(expected)] },
          });
        });
    }
    // Repeating one amenity asks for one amenity, so the cardinality cap applies
    // to the deduplicated set.
    await guest
      .get('/api/v1/rooms')
      .query(
        Array.from(
          { length: maxAmenityFilterCount + 1 },
          () => `amenity=${wifiId}`,
        ).join('&'),
      )
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ total: 2 });
      });
    await guest
      .get('/api/v1/rooms')
      .query(
        Array.from(
          { length: maxAmenityFilterCount + 1 },
          (_value, index) => `amenity=${index + 1}`,
        ).join('&'),
      )
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: {
            errors: [
              expect.objectContaining({
                field: 'amenity',
                codes: ['arrayMaxSize'],
              }),
            ],
          },
        });
      });
    // Deep pagination is bounded so one anonymous request cannot demand a huge
    // OFFSET scan.
    await guest
      .get('/api/v1/rooms')
      .query({ page: maxPageNumber + 1 })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: {
            errors: [
              expect.objectContaining({ field: 'page', codes: ['max'] }),
            ],
          },
        });
      });

    const detail = await guest.get(`/api/v1/rooms/${activeRoomId}`).expect(200);
    expect(detail.body).toMatchObject({ id: activeRoomId });
    expect(detail.body).not.toHaveProperty('roomNumber');
    await guest
      .get(`/api/v1/rooms/${activeRoomId}`)
      .query({ checkIn: '2026-10-05', checkOut: '2026-10-08' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ available: true });
      });
    await guest
      .get(`/api/v1/rooms/${activeRoomId}`)
      .query({ checkIn: '2026-10-19', checkOut: '2026-10-21' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ available: false });
      });

    // A hidden room and an absent ID answer identically, so the catalog cannot
    // be used to enumerate inactive rooms. A malformed ID is a different case:
    // it never reaches the lookup and is rejected as a validation failure.
    await guest
      .get(`/api/v1/rooms/${hiddenRoomId}`)
      .set('Accept-Language', 'vi')
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ROOM_NOT_FOUND',
          message: 'Không tìm thấy phòng.',
        });
      });
    await guest.get('/api/v1/rooms/987654321').expect(404);
    await guest
      .get('/api/v1/rooms/not-an-id')
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
  });

  async function seedCatalog(): Promise<void> {
    const roomType = await seed
      .getRepository(RoomType)
      .save(seed.getRepository(RoomType).create({ name: 'Deluxe' }));
    const amenities = seed.getRepository(Amenity);
    const wifi = await amenities.save(
      amenities.create({ code: 'WIFI', name: 'Wi-Fi' }),
    );
    const pool = await amenities.save(
      amenities.create({ code: 'POOL', name: 'Pool' }),
    );
    wifiId = wifi.id;
    poolId = pool.id;

    const rooms = seed.getRepository(Room);
    const active = await rooms.save(
      rooms.create({
        roomNumber: 'A-201',
        roomTypeId: roomType.id,
        bedCount: 2,
        viewCode: 'CITY',
        basePriceAmount: '1500000',
        currency: 'VND',
        status: RoomStatus.Active,
      }),
    );
    const second = await rooms.save(
      rooms.create({
        roomNumber: 'A-202',
        roomTypeId: roomType.id,
        bedCount: 2,
        viewCode: 'CITY',
        basePriceAmount: '1500000',
        currency: 'VND',
        status: RoomStatus.Active,
      }),
    );
    const hidden = await rooms.save(
      rooms.create({
        roomNumber: 'A-203',
        roomTypeId: roomType.id,
        bedCount: 2,
        viewCode: 'CITY',
        basePriceAmount: '1500000',
        currency: 'VND',
        status: RoomStatus.Maintenance,
      }),
    );
    activeRoomId = active.id;
    secondRoomId = second.id;
    hiddenRoomId = hidden.id;

    const assignments = seed.getRepository(RoomAmenity);
    await assignments.insert([
      { roomId: active.id, amenityId: wifi.id },
      { roomId: active.id, amenityId: pool.id },
      { roomId: second.id, amenityId: wifi.id },
    ]);
    const windows = seed.getRepository(RoomTime);
    await windows.save(
      windows.create({
        roomId: active.id,
        availableFrom: '2026-10-01',
        availableTo: '2026-10-20',
        status: RoomTimeStatus.Active,
      }),
    );
  }

  afterAll(async () => {
    if (app) await app.close();
    if (seed?.isInitialized) await seed.destroy();
    if (adminConnection && disposableDatabase) {
      try {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
        );
      } finally {
        await adminConnection.end();
      }
    }
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
