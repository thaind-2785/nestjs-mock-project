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
import { startE2eServer } from './fixtures/e2e-server';

jest.setTimeout(30_000);

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  claims: GoogleIdentityClaims = {
    subject: 'export-user',
    email: 'export-user@example.com',
    displayName: 'Export User',
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

const createPath = '/api/v1/admin/exports/rooms';

describe('Phase 6 room export create (e2e)', () => {
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
    'REPORT_EXPORT_ENABLED',
    'REPORT_EXPORT_CREATE_RATE_LIMIT_MAX',
  ];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    for (const key of environmentKeys)
      savedEnvironment.set(key, process.env[key]);
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p6_t03_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:3000/api/v1/auth/google/callback';
    process.env.AUTH_REDIS_KEY_PREFIX = `hotel:p6-t03:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    // Its own limiter namespace, at the accepted maximum, so the refusal is reachable
    // inside one journey without depending on whatever ran before it.
    process.env.RATE_LIMIT_REDIS_KEY_PREFIX = `hotel:p6-t03-rate:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    process.env.REPORT_EXPORT_ENABLED = 'true';
    process.env.REPORT_EXPORT_CREATE_RATE_LIMIT_MAX = '5';

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
        `Room export E2E prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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

  it('accepts one export from an admin and refuses everyone else', async () => {
    await request(app.getHttpServer())
      .post(createPath)
      .set('Idempotency-Key', 'room-export-anonymous')
      .send({})
      .expect(401);

    const userBrowser = request.agent(app.getHttpServer());
    const userAccess = await login(userBrowser);
    await userBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${userAccess}`)
      .set('Idempotency-Key', 'room-export-plain-user')
      .send({})
      .expect(403);
    // A refused request creates nothing, which is the part worth asserting: a job
    // written before the role check would be work an ordinary user could schedule.
    expect(await countJobs()).toBe(0);

    google.claims = {
      subject: 'export-admin',
      email: 'export-admin@example.com',
      displayName: 'Export Admin',
    };
    const adminBrowser = request.agent(app.getHttpServer());
    const adminAccess = await login(adminBrowser);
    const profile = await adminBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    await app.get(AdminBootstrapService).promote({
      userId: (profile.body as { id: string }).id,
      email: 'export-admin@example.com',
      reason: 'P6-T03 E2E bootstrap',
    });

    const accepted = await adminBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('Idempotency-Key', 'room-export-journey-1')
      .send({ status: 'ACTIVE', beds: 2, view: ' city ' })
      .expect(202);
    const body = accepted.body as { id: string; pollPath: string };
    expect(body.pollPath).toBe(`/api/v1/admin/exports/${body.id}`);
    expect(await countJobs()).toBe(1);

    // The DTO normalizes on the way in, so the stored snapshot is what the admin
    // catalogue would search with rather than what the client happened to type.
    expect(await readFilters(body.id)).toEqual({
      status: 'ACTIVE',
      beds: 2,
      view: 'CITY',
    });

    // A fresh call must not claim to have replayed anything.
    expect(accepted.headers['idempotency-replayed']).toBeUndefined();

    // Same key, same request: the stored response, and still one job.
    const replayed = await adminBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('Idempotency-Key', 'room-export-journey-1')
      .send({ beds: 2, status: 'ACTIVE', view: 'CITY' })
      .expect(202);
    // The header is how a client that timed out learns its retry created nothing.
    expect(replayed.headers['idempotency-replayed']).toBe('true');
    // Raw text, not the parsed object. MySQL returns a stored JSON object in its own
    // key order, so comparing parsed bodies would pass while the bytes a client
    // actually receives - or signs - differ between the two calls.
    expect(replayed.text).toBe(accepted.text);
    expect(await countJobs()).toBe(1);

    // Same key, different request.
    const conflict = await adminBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('Idempotency-Key', 'room-export-journey-1')
      .send({ beds: 3 })
      .expect(409);
    expect((conflict.body as { code: string }).code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );

    await adminBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({})
      .expect(400);

    // Pagination is not silently ignored: it is not part of the filter contract, so
    // an export that looks like a page request is refused rather than quietly made
    // into a full export the caller did not ask for.
    const rejected = await adminBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('Idempotency-Key', 'room-export-journey-page')
      .send({ page: 2, pageSize: 10 })
      .expect(400);
    expect((rejected.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await countJobs()).toBe(1);

    // Five calls have now reached this admin's budget: the accepted one, the replay,
    // the conflict, the missing key and the rejected page. Every one of them spent a
    // unit, because the budget protects the cost of handling a request rather than the
    // cost of the job it may or may not create - an attacker who only ever sends
    // malformed bodies is still an attacker. The sixth is refused, and refused before
    // any durable write, which is what makes it a guard rather than a cleanup.
    const limited = await adminBrowser
      .post(createPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('Idempotency-Key', 'room-export-journey-2')
      .send({})
      .expect(429);
    expect((limited.body as { code: string }).code).toBe(
      'EXPORT_CREATE_RATE_LIMITED',
    );
    expect(await countJobs()).toBe(1);
  });

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

  async function countJobs(): Promise<number> {
    const rows: Array<{ total: string | number }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM export_jobs',
    );
    return Number(rows[0].total);
  }

  async function readFilters(id: string): Promise<unknown> {
    const rows: Array<{ filters: unknown }> = await dataSource.query(
      'SELECT filters FROM export_jobs WHERE id = ?',
      [id],
    );
    return rows[0].filters;
  }
});
