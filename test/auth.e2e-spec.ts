import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import {
  GoogleAuthorizationRequest,
  GoogleCodeExchange,
  GoogleOAuthClientContract,
} from '../src/auth/google/google-oauth.client';
import { GOOGLE_OAUTH_CLIENT } from '../src/auth/auth.tokens';
import { GoogleIdentityClaims } from '../src/auth/auth.types';
import { configureApplication } from '../src/bootstrap';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { CreateAuthRbacSchema1788380000000 } from '../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { AdminBootstrapService } from '../src/users/admin-bootstrap.service';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserStatus } from '../src/users/entities/user.enums';

jest.setTimeout(30_000);

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  claims: GoogleIdentityClaims = {
    subject: 'google-user-one',
    email: 'user-one@example.com',
    displayName: 'User One',
  };

  createAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    const url = new URL('https://accounts.google.test/authorize');
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    return url.toString();
  }

  exchangeAndVerify(
    request: GoogleCodeExchange,
  ): Promise<GoogleIdentityClaims> {
    void request;
    return Promise.resolve(this.claims);
  }
}

describe('Google auth and RBAC journey (e2e)', () => {
  let app: INestApplication<App>;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let google: FakeGoogleOAuthClient;
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
    const baseEnvironment = validateEnvironment(process.env);
    disposableDatabase = `p2_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:3000/api/v1/auth/google/callback';
    process.env.AUTH_REDIS_KEY_PREFIX = `hotel:e2e:${process.pid}:${randomUUID().replaceAll('-', '')}`;

    try {
      adminConnection = await mysql.createConnection({
        host: baseEnvironment.MYSQL_HOST,
        port: baseEnvironment.MYSQL_PORT,
        user: 'root',
        password:
          process.env.MYSQL_ROOT_PASSWORD ?? 'local_mysql_root_change_me',
      });
      await adminConnection.query(
        `CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await adminConnection.query(
        `GRANT ALL PRIVILEGES ON \`${disposableDatabase}\`.* TO '${baseEnvironment.MYSQL_USER}'@'%'`,
      );
    } catch (error) {
      throw new Error(
        `Auth E2E prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const migrationDataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...baseEnvironment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities: [
            User,
            AuthIdentity,
            AuthSession,
            UserStatusHistory,
            UserRoleHistory,
          ],
          migrations: [CreateAuthRbacSchema1788380000000],
        },
      ),
    );
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    google = new FakeGoogleOAuthClient();
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GOOGLE_OAUTH_CLIENT)
      .useValue(google)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApplication(app, {
      swaggerEnabled: true,
      requestLogger: { log: jest.fn() },
    });
    await app.init();
  });

  it('rejects a copied state in another browser without consuming the owner transaction', async () => {
    const owner = request.agent(app.getHttpServer());
    const attacker = request.agent(app.getHttpServer());
    const started = await owner
      .get('/api/v1/auth/google')
      .redirects(0)
      .expect(302);
    const state = new URL(started.headers.location).searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const denied = await attacker
      .get('/api/v1/auth/google/callback')
      .query({ code: 'copied-code', state })
      .expect(401);
    expect((denied.body as unknown as { code: string }).code).toBe(
      'OAUTH_TRANSACTION_INVALID',
    );

    const completed = await owner
      .get('/api/v1/auth/google/callback')
      .query({
        code: 'owner-code',
        state,
        scope: 'openid email profile',
        authuser: '0',
        prompt: 'consent',
        hd: 'example.com',
        provider_extension: 'ignored',
      })
      .redirects(0)
      .expect('Location', '/api/docs')
      .expect(302);
    expectCallbackCookies(completed.headers['set-cookie']);
  });

  it('consumes a matching OAuth transaction when the provider callback fails', async () => {
    const browser = request.agent(app.getHttpServer());
    const started = await browser
      .get('/api/v1/auth/google')
      .redirects(0)
      .expect(302);
    const state = new URL(started.headers.location).searchParams.get('state');

    const failed = await browser
      .get('/api/v1/auth/google/callback')
      .query({
        error: 'access_denied',
        error_description: 'The user denied access',
        error_uri: 'https://accounts.google.test/error',
        state,
        provider_extension: 'ignored',
      })
      .expect(401);
    expect((failed.body as unknown as { code: string }).code).toBe(
      'GOOGLE_AUTHENTICATION_FAILED',
    );
    const replayed = await browser
      .get('/api/v1/auth/google/callback')
      .set('Cookie', `hotel_oauth_state=${state ?? ''}`)
      .query({ code: 'late-code', state })
      .expect(401);
    expect((replayed.body as unknown as { code: string }).code).toBe(
      'OAUTH_TRANSACTION_INVALID',
    );
  });

  it('consumes a matching OAuth transaction before rejecting an invalid provider result', async () => {
    const browser = request.agent(app.getHttpServer());
    const started = await browser
      .get('/api/v1/auth/google')
      .redirects(0)
      .expect(302);
    const state = new URL(started.headers.location).searchParams.get('state');

    const failed = await browser
      .get('/api/v1/auth/google/callback')
      .query({ code: 'x'.repeat(2_049), state })
      .expect(401);
    expect((failed.body as unknown as { code: string }).code).toBe(
      'GOOGLE_AUTHENTICATION_FAILED',
    );

    const replayed = await browser
      .get('/api/v1/auth/google/callback')
      .set('Cookie', `hotel_oauth_state=${state ?? ''}`)
      .query({ code: 'late-code', state })
      .expect(401);
    expect((replayed.body as unknown as { code: string }).code).toBe(
      'OAUTH_TRANSACTION_INVALID',
    );
  });

  it('provisions users, rotates cookies, enforces RBAC, and denies revoked sessions', async () => {
    google.claims = {
      subject: 'google-admin-subject',
      email: 'admin@example.com',
      displayName: 'Admin Candidate',
    };
    const adminBrowser = request.agent(app.getHttpServer());
    const adminLogin = await login(adminBrowser);
    const adminAccess = adminLogin.accessToken;
    const adminProfile = await adminBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const adminProfileBody = adminProfile.body as unknown as {
      id: string;
      email: string;
      role: string;
      status: string;
    };
    expect(adminProfileBody).toMatchObject({
      email: 'admin@example.com',
      role: 'USER',
      status: 'ACTIVE',
    });
    await adminBrowser
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(403);

    await app.get(AdminBootstrapService).promote({
      userId: adminProfileBody.id,
      email: 'admin@example.com',
      reason: 'E2E bootstrap',
    });
    await adminBrowser
      .get('/api/v1/admin/users')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    google.claims = {
      subject: 'google-user-subject',
      email: 'guest@example.com',
      displayName: 'Guest',
    };
    const userBrowser = request.agent(app.getHttpServer());
    const userLogin = await login(userBrowser);
    const userProfile = await userBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${userLogin.accessToken}`)
      .expect(200);
    const userProfileBody = userProfile.body as unknown as { id: string };

    await adminBrowser
      .patch(`/api/v1/admin/users/${userProfileBody.id}/status`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: UserStatus.Inactive, reason: 'E2E inactivation' })
      .expect(200)
      .expect((response) => {
        expect((response.body as unknown as { status: string }).status).toBe(
          'INACTIVE',
        );
      });

    const denied = await userBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${userLogin.accessToken}`)
      .expect(401);
    expect((denied.body as unknown as { code: string }).code).toBe(
      'SESSION_INVALID',
    );

    await adminBrowser
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await adminBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(401);
  });

  async function login(
    browser: ReturnType<typeof request.agent>,
  ): Promise<{ accessToken: string }> {
    const started = await browser
      .get('/api/v1/auth/google')
      .redirects(0)
      .expect(302);
    const location = new URL(started.headers.location);
    const state = location.searchParams.get('state');
    expect(location.hostname).toBe('accounts.google.test');
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.searchParams.get('code_challenge')).toBeTruthy();

    const callback = await browser
      .get('/api/v1/auth/google/callback')
      .query({ code: randomUUID(), state })
      .redirects(0)
      .expect(302);
    expect(callback.headers.location).toBe('/api/docs');
    expectCallbackCookies(callback.headers['set-cookie']);

    const refreshed = await browser.post('/api/v1/auth/refresh').expect(200);
    const refreshBody = refreshed.body as unknown as {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
    };
    expect(typeof refreshBody.accessToken).toBe('string');
    expect(refreshBody).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    return { accessToken: refreshBody.accessToken };
  }

  function expectCallbackCookies(header: unknown): void {
    const setCookies = header as string[];
    const combined = setCookies.join(';');
    expect(combined).toContain('hotel_refresh=');
    expect(combined).toContain('Path=/api/v1/auth');
    expect(combined).toContain('HttpOnly');
    expect(combined).toContain('SameSite=Lax');
    expect(combined).toContain('hotel_oauth_state=;');
    expect(combined).toContain('Path=/api/v1/auth/google/callback');
    expect(combined).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
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
