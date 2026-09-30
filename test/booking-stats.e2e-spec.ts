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
import { applicationEntities } from '../src/database/application-entities';
import { createTypeOrmOptions } from '../src/database/database.options';
import { AdminBootstrapService } from '../src/users/admin-bootstrap.service';
import { applicationMigrations } from './fixtures/application-migrations';
import { startE2eServer } from './fixtures/http-server';

jest.setTimeout(30_000);

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  claims: GoogleIdentityClaims = {
    subject: 'stats-user',
    email: 'stats-user@example.com',
    displayName: 'Stats User',
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

const reportPath = '/api/v1/admin/reports/booking-stats';

/**
 * The admin statistics journey over HTTP (`ADMIN-RPT-01`).
 *
 * The read model is seeded directly: how rows reach it - relay, topic, consumer - is
 * the integration suite's subject, against a real broker. What this journey owns is the
 * HTTP contract around it: who may read it, how a request is validated, and the shape
 * an administrator receives.
 */
describe('Phase 9 booking statistics (e2e)', () => {
  let app: INestApplication<App>;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let google: FakeGoogleOAuthClient;
  let dataSource: DataSource;
  const savedEnvironment = new Map<string, string | undefined>();
  const environmentKeys = [
    'NODE_ENV',
    'MYSQL_DATABASE',
    'GOOGLE_AUTH_ENABLED',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'AUTH_REDIS_KEY_PREFIX',
    'RATE_LIMIT_REDIS_KEY_PREFIX',
    'BOOKING_STREAM_ENABLED',
  ];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    for (const key of environmentKeys)
      savedEnvironment.set(key, process.env[key]);
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p9_t02_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:3000/api/v1/auth/google/callback';
    process.env.AUTH_REDIS_KEY_PREFIX = `hotel:p9-t02:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    process.env.RATE_LIMIT_REDIS_KEY_PREFIX = `hotel:p9-t02-rate:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    // The API reads the flag to serve the report; it never opens a Kafka connection.
    process.env.BOOKING_STREAM_ENABLED = 'true';

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
        `Booking statistics E2E prerequisite unavailable. Start npm run compose:ci and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        { entities: applicationEntities, migrations: applicationMigrations },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    google = new FakeGoogleOAuthClient();
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH_CLIENT)
      .useValue(google)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, {
      swaggerEnabled: false,
      requestLogger: { log: jest.fn() },
    });
    await startE2eServer(app);
  });

  afterAll(async () => {
    if (app) await app.close();
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
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('serves the report to an admin and refuses everyone else', async () => {
    await seedFacts();
    const query = { from: '2026-10-01', to: '2026-12-01', groupBy: 'month' };

    await request(app.getHttpServer()).get(reportPath).query(query).expect(401);

    const userBrowser = request.agent(app.getHttpServer());
    const userAccess = await login(userBrowser);
    await userBrowser
      .get(reportPath)
      .query(query)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(403);

    google.claims = {
      subject: 'stats-admin',
      email: 'stats-admin@example.com',
      displayName: 'Stats Admin',
    };
    const adminBrowser = request.agent(app.getHttpServer());
    const adminAccess = await login(adminBrowser);
    const profile = await adminBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    await app.get(AdminBootstrapService).promote({
      userId: (profile.body as { id: string }).id,
      email: 'stats-admin@example.com',
      reason: 'P9-T02 E2E bootstrap',
    });

    const response = await adminBrowser
      .get(reportPath)
      .query(query)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      from: '2026-10-01',
      to: '2026-12-01',
      roomTypeId: null,
      groupBy: 'month',
      asOf: '2026-09-30T08:00:03.000Z',
      totals: {
        bookings: 3,
        byStatus: {
          PENDING: 1,
          CONFIRMED: 1,
          REJECTED: 0,
          CANCELLED_BY_USER: 0,
          CANCELLED_BY_ADMIN: 1,
          COMPLETED: 0,
        },
        projectedRevenue: [{ currency: 'VND', amount: 4_500_000 }],
      },
      buckets: [
        {
          period: '2026-10-01',
          bookings: 2,
          byStatus: {
            PENDING: 1,
            CONFIRMED: 1,
            REJECTED: 0,
            CANCELLED_BY_USER: 0,
            CANCELLED_BY_ADMIN: 0,
            COMPLETED: 0,
          },
          projectedRevenue: [{ currency: 'VND', amount: 4_500_000 }],
        },
        {
          period: '2026-11-01',
          bookings: 1,
          byStatus: {
            PENDING: 0,
            CONFIRMED: 0,
            REJECTED: 0,
            CANCELLED_BY_USER: 0,
            CANCELLED_BY_ADMIN: 1,
            COMPLETED: 0,
          },
          projectedRevenue: [],
        },
      ],
    });

    // A span the report refuses has its own code; a malformed value is a validation
    // failure, and neither reaches the read model.
    const inverted = await adminBrowser
      .get(reportPath)
      .query({ from: '2026-12-01', to: '2026-10-01' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);
    expect((inverted.body as { code: string }).code).toBe(
      'BOOKING_STATS_RANGE_INVALID',
    );
    const malformed = await adminBrowser
      .get(reportPath)
      .query({ from: '2026-10-01', to: '2026-12-01', groupBy: 'week' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);
    expect((malformed.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  async function seedFacts(): Promise<void> {
    const rows = [
      [
        '01K4N8G4X8R0K1F2Q7V6S9T3AB',
        2,
        'CONFIRMED',
        '2026-10-10',
        4_500_000,
        1,
      ],
      ['01K4N8G4X8R0K1F2Q7V6S9T3AC', 1, 'PENDING', '2026-10-20', 3_000_000, 2],
      [
        '01K4N8G4X8R0K1F2Q7V6S9T3AD',
        3,
        'CANCELLED_BY_ADMIN',
        '2026-11-05',
        1_500_000,
        3,
      ],
      // Outside the range: must not be counted.
      [
        '01K4N8G4X8R0K1F2Q7V6S9T3AE',
        2,
        'CONFIRMED',
        '2026-12-01',
        9_000_000,
        0,
      ],
    ] as const;
    for (const [id, version, status, checkIn, amount, second] of rows) {
      const checkOut = new Date(`${checkIn}T00:00:00.000Z`);
      checkOut.setUTCDate(checkOut.getUTCDate() + 3);
      await dataSource.query(
        `INSERT INTO booking_stats_facts
           (booking_public_id, booking_version, status, room_id, room_type_id,
            check_in, check_out, price_amount, currency, last_event_id,
            last_occurred_at)
         VALUES (?, ?, ?, '12', '3', ?, ?, ?, 'VND', ?, ?)`,
        [
          id,
          version,
          status,
          checkIn,
          checkOut.toISOString().slice(0, 10),
          amount,
          randomUUID(),
          new Date(`2026-09-30T08:00:0${second}.000Z`),
        ],
      );
    }
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
});
