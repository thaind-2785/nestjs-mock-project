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
import { CreateBookingCoreSchema1788580000000 } from '../src/database/migrations/1788580000000-CreateBookingCoreSchema';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { User } from '../src/users/entities/user.entity';
import { UserRole } from '../src/users/entities/user.enums';

jest.setTimeout(30_000);

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  claims: GoogleIdentityClaims = {
    subject: 'booking-e2e-user',
    email: 'booking-e2e@example.com',
    displayName: 'Booking E2E User',
  };

  createAuthorizationUrl(input: GoogleAuthorizationRequest): string {
    const url = new URL('https://accounts.google.test/authorize');
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  exchangeAndVerify(input: GoogleCodeExchange): Promise<GoogleIdentityClaims> {
    void input;
    return Promise.resolve(this.claims);
  }
}

describe('P4-T02 booking create API', () => {
  let app: INestApplication<App>;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let googleOAuthClient: FakeGoogleOAuthClient;
  const savedEnvironment = new Map<string, string | undefined>();
  const environmentKeys = [
    'NODE_ENV',
    'MYSQL_DATABASE',
    'GOOGLE_AUTH_ENABLED',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'RATE_LIMIT_REDIS_KEY_PREFIX',
    'BOOKING_CREATE_RATE_LIMIT_MAX',
  ];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    for (const key of environmentKeys)
      savedEnvironment.set(key, process.env[key]);
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p4_t02_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:3000/api/v1/auth/google/callback';
    process.env.RATE_LIMIT_REDIS_KEY_PREFIX = `hotel:p4-t02:${randomUUID().replaceAll('-', '')}`;
    process.env.BOOKING_CREATE_RATE_LIMIT_MAX = '3';

    adminConnection = await mysql.createConnection({
      host: environment.MYSQL_HOST,
      port: environment.MYSQL_PORT,
      user: 'root',
      password: process.env.MYSQL_ROOT_PASSWORD ?? 'local_mysql_root_change_me',
    });
    await adminConnection.query(
      `CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await adminConnection.query(
      `GRANT ALL PRIVILEGES ON \`${disposableDatabase}\`.* TO '${environment.MYSQL_USER}'@'%'`,
    );

    const migrationDataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          migrations: [
            CreateAuthRbacSchema1788380000000,
            CreateRoomCatalogSchema1788490000000,
            CreateBookingCoreSchema1788580000000,
          ],
        },
      ),
    );
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    googleOAuthClient = new FakeGoogleOAuthClient();
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH_CLIENT)
      .useValue(googleOAuthClient)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, { requestLogger: { log: jest.fn() } });
    await app.init();
  });

  it('requires a user session and creates, replays, then rejects a conflicting retry', async () => {
    const server = app.getHttpServer();
    await request(server).post('/api/v1/bookings').expect(401);

    const browser = request.agent(server);
    const accessToken = await login(browser);
    const dates = bookingFixtureDates();
    const roomId = await createRoom(dates);
    const body = {
      roomId,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
    };

    const created = await browser
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'booking-e2e-create-retry')
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      room: { id: roomId },
      nights: 3,
      status: 'PENDING',
      price: { amount: 4500000, currency: 'VND' },
    });

    await browser
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'booking-e2e-create-retry')
      .send(body)
      .expect(201)
      .expect(created.body);

    const conflict = await browser
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'booking-e2e-create-retry')
      .send({ ...body, checkOut: dates.checkOutDifferent })
      .expect(409);
    expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const bookingId = (created.body as { id: string }).id;

    await browser
      .get('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          total: 1,
          items: [{ id: bookingId }],
        });
      });
    await browser
      .get('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .query({ status: 'PENDING', page: 1, pageSize: 20 })
      .expect(200)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({
          total: 1,
          items: [{ id: bookingId }],
        });
      });
    const detail = await browser
      .get(`/api/v1/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(detail.body as unknown).toMatchObject({
      id: bookingId,
      history: [{ toStatus: 'PENDING' }],
    });
    const cancelled = await browser
      .post(`/api/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(cancelled.body as unknown).toMatchObject({
      status: 'CANCELLED_BY_USER',
    });
    await browser
      .post(`/api/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect((body as { history: unknown[] }).history).toHaveLength(2),
      );

    googleOAuthClient.claims = {
      subject: 'booking-e2e-other-user',
      email: 'booking-e2e-other@example.com',
      displayName: 'Booking E2E Other User',
    };
    const otherBrowser = request.agent(server);
    const otherAccessToken = await login(otherBrowser);
    await otherBrowser
      .get('/api/v1/bookings')
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body as unknown).toMatchObject({ total: 0, items: [] });
      });
    await otherBrowser
      .get(`/api/v1/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .expect(404)
      .expect(({ body }) =>
        expect(body as unknown).toMatchObject({ code: 'BOOKING_NOT_FOUND' }),
      );
    await otherBrowser
      .post(`/api/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${otherAccessToken}`)
      .expect(404)
      .expect(({ body }) =>
        expect(body as unknown).toMatchObject({ code: 'BOOKING_NOT_FOUND' }),
      );

    const rateLimited = await browser
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'booking-e2e-over-budget-2026')
      .send(body)
      .expect(429);
    expect(rateLimited.body).toMatchObject({
      code: 'BOOKING_CREATE_RATE_LIMITED',
    });

    const dataSource = app.get(DataSource);
    await dataSource
      .getRepository(User)
      .update({ email: 'booking-e2e@example.com' }, { role: UserRole.Admin });
    await browser
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'booking-e2e-admin-forbidden')
      .send(body)
      .expect(403);
    await browser
      .get('/api/v1/bookings')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
  });

  async function createRoom(dates: BookingFixtureDates): Promise<string> {
    const dataSource = app.get(DataSource);
    const roomType = await dataSource.getRepository(RoomType).save({
      name: `Booking E2E ${randomUUID()}`,
      description: null,
    });
    const room = await dataSource.getRepository(Room).save({
      roomTypeId: roomType.id,
      roomNumber: `E-${randomUUID().slice(0, 8)}`,
      bedCount: 2,
      viewCode: null,
      basePriceAmount: '1500000',
      currency: 'VND',
      status: RoomStatus.Active,
    });
    await dataSource.getRepository(RoomTime).save({
      roomId: room.id,
      availableFrom: dates.availableFrom,
      availableTo: dates.availableTo,
      status: RoomTimeStatus.Active,
    });
    return room.id;
  }

  async function login(
    browser: ReturnType<typeof request.agent>,
  ): Promise<string> {
    const started = await browser
      .get('/api/v1/auth/google')
      .redirects(0)
      .expect(302);
    const state = new URL(started.headers.location).searchParams.get('state');
    await browser
      .get('/api/v1/auth/google/callback')
      .query({ code: randomUUID(), state })
      .redirects(0)
      .expect(302);
    const refreshed = await browser.post('/api/v1/auth/refresh').expect(200);
    return (refreshed.body as { accessToken: string }).accessToken;
  }

  afterAll(async () => {
    if (app) await app.close();
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

interface BookingFixtureDates {
  availableFrom: string;
  checkIn: string;
  checkOut: string;
  checkOutDifferent: string;
  availableTo: string;
}

function bookingFixtureDates(): BookingFixtureDates {
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
  };
}
