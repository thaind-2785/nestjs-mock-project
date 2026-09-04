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
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { AdminBootstrapService } from '../src/users/admin-bootstrap.service';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';

jest.setTimeout(30_000);

class FakeGoogleOAuthClient implements GoogleOAuthClientContract {
  claims: GoogleIdentityClaims = {
    subject: 'room-admin-user',
    email: 'room-user@example.com',
    displayName: 'Room User',
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

describe('P3-T02 admin room API (e2e)', () => {
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
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t02_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    process.env.GOOGLE_AUTH_ENABLED = 'true';
    process.env.GOOGLE_CLIENT_ID = 'fake-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-google-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:3000/api/v1/auth/google/callback';
    process.env.AUTH_REDIS_KEY_PREFIX = `hotel:p3-t02:${process.pid}:${randomUUID().replaceAll('-', '')}`;

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
        `Room admin E2E prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const migrationDataSource = new DataSource(
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
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    await migrationDataSource.destroy();

    google = new FakeGoogleOAuthClient();
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_OAUTH_CLIENT)
      .useValue(google)
      .compile();
    app = fixture.createNestApplication();
    configureApplication(app, {
      swaggerEnabled: true,
      requestLogger: { log: jest.fn() },
    });
    await app.init();
  });

  it('enforces RBAC and completes the admin catalog and room lifecycle', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/rooms').expect(401);

    const userBrowser = request.agent(app.getHttpServer());
    const userAccess = await login(userBrowser);
    await userBrowser
      .get('/api/v1/admin/rooms')
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(403);

    google.claims = {
      subject: 'room-admin',
      email: 'room-admin@example.com',
      displayName: 'Room Admin',
    };
    const adminBrowser = request.agent(app.getHttpServer());
    const adminAccess = await login(adminBrowser);
    const profile = await adminBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    const adminId = (profile.body as unknown as { id: string }).id;
    await app.get(AdminBootstrapService).promote({
      userId: adminId,
      email: 'room-admin@example.com',
      reason: 'P3-T02 E2E bootstrap',
    });

    const roomType = await adminBrowser
      .post('/api/v1/admin/room-types')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: ' Deluxe ', description: ' City rooms ' })
      .expect(201);
    const roomTypeId = (roomType.body as unknown as { id: string }).id;
    await adminBrowser
      .get(`/api/v1/admin/room-types/${roomTypeId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          name: 'Deluxe',
          description: 'City rooms',
        });
      });
    await adminBrowser
      .patch(`/api/v1/admin/room-types/${roomTypeId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ description: 'Updated room type' })
      .expect(200);
    await adminBrowser
      .get('/api/v1/admin/room-types')
      .query({ query: 'del', page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ total: 1 });
      });

    const amenity = await adminBrowser
      .post('/api/v1/admin/amenities')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ code: ' wifi ', name: ' Wi-Fi ' })
      .expect(201);
    const amenityId = (amenity.body as unknown as { id: string }).id;
    expect(amenity.body).toMatchObject({ code: 'WIFI', name: 'Wi-Fi' });
    await adminBrowser
      .get(`/api/v1/admin/amenities/${amenityId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    await adminBrowser
      .patch(`/api/v1/admin/amenities/${amenityId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Wireless internet' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'WIFI',
          name: 'Wireless internet',
        });
      });
    await adminBrowser
      .get('/api/v1/admin/amenities')
      .query({ query: 'wi', page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ total: 1 });
      });

    const created = await adminBrowser
      .post('/api/v1/admin/rooms')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        roomNumber: ' A-201 ',
        roomTypeId,
        bedCount: 2,
        viewCode: ' city ',
        basePriceAmount: 1_500_000,
        currency: ' vnd ',
        amenityIds: [amenityId],
      })
      .expect(201);
    const roomId = (created.body as unknown as { id: string }).id;
    expect(created.body).toMatchObject({
      roomNumber: 'A-201',
      viewCode: 'CITY',
      basePriceAmount: 1_500_000,
      currency: 'VND',
      version: 1,
      amenities: [{ id: amenityId, code: 'WIFI' }],
    });
    await adminBrowser
      .get(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ id: roomId, version: 1 });
      });

    await adminBrowser
      .get('/api/v1/admin/rooms')
      .query({ query: 'delux', status: 'ACTIVE', beds: 2, view: 'city' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          total: 1,
          items: [{ id: roomId }],
        });
      });
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'MAINTENANCE' })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ROOM_VERSION_CONFLICT' });
      });

    const updated = await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('If-Match', '"1"')
      .send({ status: 'MAINTENANCE', amenityIds: [] })
      .expect(200);
    expect(updated.body).toMatchObject({
      status: 'MAINTENANCE',
      amenities: [],
      version: 2,
    });
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('If-Match', '"2"')
      .send({})
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: {
            errors: [{ field: '$body', codes: ['isNotEmptyObject'] }],
          },
        });
      });
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('If-Match', '"1"')
      .send({ status: 'ACTIVE' })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ROOM_VERSION_CONFLICT' });
      });

    await adminBrowser
      .delete(`/api/v1/admin/room-types/${roomTypeId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ROOM_TYPE_IN_USE' });
      });
    await adminBrowser
      .delete(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await adminBrowser
      .delete(`/api/v1/admin/room-types/${roomTypeId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await adminBrowser
      .delete(`/api/v1/admin/amenities/${amenityId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    await adminBrowser
      .get(`/api/v1/admin/rooms/${roomId}`)
      .set('Accept-Language', 'vi')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ROOM_NOT_FOUND',
          message: 'Không tìm thấy phòng.',
        });
      });
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
    return (refreshed.body as unknown as { accessToken: string }).accessToken;
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
