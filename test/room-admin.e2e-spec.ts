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
import { ensureAttachmentBucket } from './fixtures/room-images';

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

describe('Phase 3 admin room API (e2e)', () => {
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
    'ROOM_IMAGE_MAX_BYTES',
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
    // A small content limit keeps the size-limit case cheap while still crossing the
    // real multipart boundary rather than a mocked one.
    process.env.ROOM_IMAGE_MAX_BYTES = '2048';

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
    await ensureAttachmentBucket(validateEnvironment(process.env));
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
      .query({ query: 'delux', status: 'ACTIVE', beds: 2, view: ' city ' })
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          total: 1,
          items: [{ id: roomId }],
        });
      });

    await request(app.getHttpServer())
      .post(`/api/v1/admin/rooms/${roomId}/times`)
      .send({
        availableFrom: '2026-10-01',
        availableTo: '2026-11-01',
      })
      .expect(401);
    await userBrowser
      .get(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${userAccess}`)
      .expect(403);
    await adminBrowser
      .post(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        availableFrom: '2026-02-30',
        availableTo: '2026-03-10',
      })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    await adminBrowser
      .post(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        availableFrom: '2026-10-01',
        availableTo: '2026-10-01',
      })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ROOM_TIME_RANGE_INVALID',
        });
      });
    const firstWindow = await adminBrowser
      .post(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        availableFrom: '2026-10-01',
        availableTo: '2026-11-01',
      })
      .expect(201);
    const firstWindowId = (firstWindow.body as unknown as { id: string }).id;
    expect(firstWindow.body).toMatchObject({
      roomId,
      availableFrom: '2026-10-01',
      availableTo: '2026-11-01',
      status: 'ACTIVE',
      usage: {
        bookingCount: 0,
        activeBookingCount: 0,
        changeHistoryCount: 0,
      },
    });
    await adminBrowser
      .post(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('Accept-Language', 'vi')
      .send({
        availableFrom: '2026-10-15',
        availableTo: '2026-11-15',
      })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ROOM_TIME_OVERLAP',
          message:
            'Khung thời gian đang hoạt động bị trùng với một khung thời gian khác của phòng này.',
        });
      });
    const adjacentWindow = await adminBrowser
      .post(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        availableFrom: '2026-11-01',
        availableTo: '2026-12-01',
      })
      .expect(201);
    const adjacentWindowId = (adjacentWindow.body as unknown as { id: string })
      .id;
    await adminBrowser
      .get(`/api/v1/admin/rooms/${roomId}/times`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject([
          {
            id: firstWindowId,
            availableFrom: '2026-10-01',
            availableTo: '2026-11-01',
          },
          {
            id: adjacentWindowId,
            availableFrom: '2026-11-01',
            availableTo: '2026-12-01',
          },
        ]);
      });
    await adminBrowser
      .get('/api/v1/admin/rooms/not-an-id/times')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    await adminBrowser
      .delete(`/api/v1/admin/rooms/${roomId}/times/not-an-id`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}/times/${adjacentWindowId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({})
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      });
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}/times/${adjacentWindowId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'INACTIVE' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({ status: 'INACTIVE' });
      });

    const secondRoom = await adminBrowser
      .post('/api/v1/admin/rooms')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        roomNumber: 'A-202',
        roomTypeId,
        bedCount: 2,
        basePriceAmount: 1_500_000,
        currency: 'VND',
      })
      .expect(201);
    const secondRoomId = (secondRoom.body as unknown as { id: string }).id;
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${secondRoomId}/times/${firstWindowId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'INACTIVE' })
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ROOM_TIME_NOT_FOUND' });
      });
    await adminBrowser
      .delete(`/api/v1/admin/rooms/${roomId}/times/${adjacentWindowId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await adminBrowser
      .delete(`/api/v1/admin/rooms/${secondRoomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ status: 'MAINTENANCE' })
      .expect(428)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ROOM_VERSION_REQUIRED' });
      });

    for (const header of ['1', '*', 'W/"1"', '"1", "2"']) {
      await adminBrowser
        .patch(`/api/v1/admin/rooms/${roomId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .set('If-Match', header)
        .set('Accept-Language', 'vi')
        .send({ status: 'ACTIVE' })
        .expect(400)
        .expect((response) => {
          expect(response.body).toMatchObject({
            code: 'ROOM_VERSION_MALFORMED',
            message:
              'If-Match phải chứa một phiên bản phòng dạng số nguyên dương trong dấu ngoặc kép.',
          });
        });
    }
    for (const field of [
      'roomNumber',
      'roomTypeId',
      'bedCount',
      'basePriceAmount',
      'currency',
      'status',
      'amenityIds',
    ]) {
      await adminBrowser
        .patch(`/api/v1/admin/rooms/${roomId}`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .set('If-Match', '"1"')
        .send({ [field]: null })
        .expect(400)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
        });
    }
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
      .expect(412)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ROOM_VERSION_CONFLICT' });
      });

    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('If-Match', '"2"')
      .send({ amenityIds: [amenityId] })
      .expect(200)
      .expect((response) => {
        expect(response.body).toMatchObject({
          version: 3,
          amenities: [{ id: amenityId }],
        });
      });
    await adminBrowser
      .patch(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('If-Match', '"2"')
      .send({ amenityIds: [] })
      .expect(412);
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

  it('uploads, replaces, reorders, and detaches room images over HTTP', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x31),
    ]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0x32),
    ]);

    google.claims = {
      subject: 'room-image-admin',
      email: 'room-image-admin@example.com',
      displayName: 'Image Admin',
    };
    const adminBrowser = request.agent(app.getHttpServer());
    const adminAccess = await login(adminBrowser);
    const profile = await adminBrowser
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    await app.get(AdminBootstrapService).promote({
      userId: (profile.body as unknown as { id: string }).id,
      email: 'room-image-admin@example.com',
      reason: 'P3-T05 E2E bootstrap',
    });

    const roomType = await adminBrowser
      .post('/api/v1/admin/room-types')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Image Suite' })
      .expect(201);
    const room = await adminBrowser
      .post('/api/v1/admin/rooms')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        roomNumber: 'IMG-101',
        roomTypeId: (roomType.body as unknown as { id: string }).id,
        bedCount: 2,
        basePriceAmount: 1_500_000,
        currency: 'VND',
        amenityIds: [],
      })
      .expect(201);
    const roomId = (room.body as unknown as { id: string }).id;
    const imagesPath = `/api/v1/admin/rooms/${roomId}/images`;

    // Deny-by-default still applies to the multipart route.
    await request(app.getHttpServer())
      .post(imagesPath)
      .field('associationType', 'THUMBNAIL')
      .attach('file', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(401);
    const userBrowser = request.agent(app.getHttpServer());
    google.claims = {
      subject: 'room-image-guest',
      email: 'room-image-guest@example.com',
      displayName: 'Image Guest',
    };
    const userAccess = await login(userBrowser);
    await userBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${userAccess}`)
      .field('associationType', 'THUMBNAIL')
      .attach('file', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(403);

    const uploaded = await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'THUMBNAIL')
      .attach('file', png, {
        filename: '../../etc/passwd',
        contentType: 'image/png',
      })
      .expect(201);
    const thumbnail = uploaded.body as unknown as {
      id: string;
      url: string;
      position: number;
    };
    expect(thumbnail.position).toBe(0);
    // The client filename never reaches the storage path.
    expect(thumbnail.url).not.toContain('passwd');
    expect((await fetch(thumbnail.url)).status).toBe(200);

    // A declared type outside the allowlist is refused before the bytes matter.
    await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'ALBUM')
      .attach('file', Buffer.from('%PDF-1.7'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      })
      .expect(415)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ATTACHMENT_MIME_UNSUPPORTED',
        });
      });
    // An accepted header over other bytes is refused by the signature check.
    await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'ALBUM')
      .attach('file', Buffer.from('%PDF-1.7 pretending to be a photo'), {
        filename: 'fake.png',
        contentType: 'image/png',
      })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ATTACHMENT_CONTENT_INVALID',
        });
      });
    // The multipart boundary and the content policy report the same code.
    await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'ALBUM')
      .attach('file', Buffer.concat([png, Buffer.alloc(4_096, 0x33)]), {
        filename: 'big.png',
        contentType: 'image/png',
      })
      .expect(413)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ATTACHMENT_SIZE_EXCEEDED',
        });
      });
    await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'ALBUM')
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { errors: [{ field: 'file', codes: ['isDefined'] }] },
        });
      });

    const albumFirst = await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'ALBUM')
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    const albumSecond = await adminBrowser
      .post(imagesPath)
      .set('Authorization', `Bearer ${adminAccess}`)
      .field('associationType', 'ALBUM')
      .attach('file', jpeg, { filename: 'b.jpg', contentType: 'image/jpeg' })
      .expect(201);
    const firstId = (albumFirst.body as unknown as { id: string }).id;
    const secondId = (albumSecond.body as unknown as { id: string }).id;

    await adminBrowser
      .patch(`${imagesPath}/order`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ attachmentIds: [firstId] })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ATTACHMENT_ORDER_INVALID',
        });
      });
    await adminBrowser
      .patch(`${imagesPath}/order`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ attachmentIds: [secondId, firstId] })
      .expect(200)
      .expect((response) => {
        expect(
          (response.body as unknown as { id: string; position: number }[]).map(
            ({ id, position }) => ({ id, position }),
          ),
        ).toEqual([
          { id: secondId, position: 0 },
          { id: firstId, position: 1 },
        ]);
      });

    // Admin detail publishes the thumbnail and the album in stored order.
    await adminBrowser
      .get(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as unknown as {
          thumbnail: { id: string } | null;
          images: { id: string }[];
        };
        expect(body.thumbnail?.id).toBe(thumbnail.id);
        expect(body.images.map(({ id }) => id)).toEqual([secondId, firstId]);
      });

    // The public payload carries only the short-lived read.
    await request(app.getHttpServer())
      .get(`/api/v1/rooms/${roomId}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as unknown as {
          thumbnail: Record<string, unknown> | null;
          images: Record<string, unknown>[];
        };
        expect(Object.keys(body.thumbnail ?? {}).sort()).toEqual([
          'expiresAt',
          'url',
        ]);
        expect(body.images).toHaveLength(2);
      });

    // A foreign attachment ID is indistinguishable from an absent one.
    await adminBrowser
      .delete(`/api/v1/admin/rooms/${roomId}/images/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
      });
    await adminBrowser
      .delete(`${imagesPath}/${firstId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await adminBrowser
      .get(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200)
      .expect((response) => {
        const body = response.body as unknown as {
          images: { id: string; position: number }[];
        };
        expect(body.images).toEqual([
          expect.objectContaining({ id: secondId, position: 0 }),
        ]);
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
