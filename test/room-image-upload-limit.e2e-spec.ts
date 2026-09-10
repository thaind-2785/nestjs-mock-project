import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { SessionService } from '../src/auth/session.service';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import { configureApplication } from '../src/bootstrap';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
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
import { RoomStatus } from '../src/rooms/entities/room.enums';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { ensureAttachmentBucket } from './fixtures/room-images';

jest.setTimeout(60_000);

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(96, 0x21),
]);

const entities = [
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
];

/**
 * The upload budget is enforced by a guard rather than inside the handler, because
 * Nest runs guards before the multipart interceptor buffers the request body. That
 * ordering is only observable over real HTTP, and one assertion pins it: once the
 * budget is spent, a body ABOVE the size limit must answer `429`. If the budget were
 * charged in the handler, Multer would reject the same request with `413` first.
 */
describe('Room image upload budget over HTTP (e2e)', () => {
  let app: INestApplication<App>;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let accessToken: string;
  let roomId: string;
  const savedEnvironment = new Map<string, string | undefined>();
  const environmentKeys = [
    'NODE_ENV',
    'MYSQL_DATABASE',
    'RATE_LIMIT_REDIS_KEY_PREFIX',
    'ATTACHMENT_UPLOAD_RATE_LIMIT_MAX',
    'ROOM_IMAGE_MAX_BYTES',
  ];

  beforeAll(async () => {
    loadRepositoryEnvironment();
    for (const key of environmentKeys)
      savedEnvironment.set(key, process.env[key]);
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t06_e2e_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    process.env.NODE_ENV = 'test';
    process.env.MYSQL_DATABASE = disposableDatabase;
    // A budget of one makes the refusal the second request, and a small content
    // limit keeps the oversized-body case cheap while still crossing the real
    // multipart boundary.
    process.env.RATE_LIMIT_REDIS_KEY_PREFIX = `hotel:p3-t06-rate:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    process.env.ATTACHMENT_UPLOAD_RATE_LIMIT_MAX = '1';
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
        `Upload budget E2E prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const migrationDataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities,
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

    const fixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = fixture.createNestApplication();
    configureApplication(app, {
      swaggerEnabled: false,
      requestLogger: { log: jest.fn() },
    });
    await app.init();
    await ensureAttachmentBucket(validateEnvironment(process.env));

    // A seeded admin plus a real session is enough: this suite is about the upload
    // boundary, and the Google journey is already covered by the auth E2E.
    const dataSource = app.get(DataSource);
    // The application DataSource connects lazily, so entity metadata is not
    // available until the first request would have initialized it.
    await app.get(DatabaseConnectionService).ensureInitialized();
    const admin = await dataSource.manager.save(
      dataSource.manager.create(User, {
        email: 'upload-budget@example.com',
        displayName: 'Budget Admin',
        role: UserRole.Admin,
        status: UserStatus.Active,
        emailVerifiedAt: new Date(),
      }),
    );
    accessToken = (await app.get(SessionService).create(admin)).accessToken;
    const roomType = await dataSource.manager.save(
      dataSource.manager.create(RoomType, { name: 'Budget Suite' }),
    );
    const room = await dataSource.manager.save(
      dataSource.manager.create(Room, {
        roomNumber: 'B-101',
        roomTypeId: roomType.id,
        bedCount: 2,
        viewCode: 'CITY',
        basePriceAmount: '1500000',
        currency: 'VND',
        status: RoomStatus.Active,
      }),
    );
    roomId = room.id;
  });

  afterAll(async () => {
    await app?.close();
    if (adminConnection && disposableDatabase) {
      await adminConnection.query(
        `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
      );
      await adminConnection.end();
    }
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses an over-budget upload before the request body is read', async () => {
    const path = `/api/v1/admin/rooms/${roomId}/images`;

    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${accessToken}`)
      .field('associationType', 'ALBUM')
      .attach('file', pngBytes, { filename: 'first.png' })
      .expect(201);

    // Above ROOM_IMAGE_MAX_BYTES: 413 here would mean Multer read the body first.
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${accessToken}`)
      .field('associationType', 'ALBUM')
      .attach('file', Buffer.alloc(8_192, 0x21), { filename: 'oversized.png' })
      .expect(429)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'ATTACHMENT_UPLOAD_RATE_LIMITED',
        });
      });

    // Localized, and still no second attachment or cleanup safeguard anywhere.
    await request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Accept-Language', 'vi')
      .field('associationType', 'ALBUM')
      .attach('file', pngBytes, { filename: 'third.png' })
      .expect(429)
      .expect((response) => {
        expect((response.body as { message: string }).message).toBe(
          'Bạn đã tải lên quá nhiều ảnh. Hãy đợi một lát rồi thử lại.',
        );
      });

    const dataSource = app.get(DataSource);
    expect(await dataSource.manager.count(Attachment)).toBe(1);
    expect(await dataSource.manager.count(StorageCleanupTask)).toBe(0);
  });

  it('keeps the budget out of the read paths and off other uploaders', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/admin/rooms/${roomId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const dataSource = app.get(DataSource);
    const secondAdmin = await dataSource.manager.save(
      dataSource.manager.create(User, {
        email: 'second-budget@example.com',
        displayName: 'Second Admin',
        role: UserRole.Admin,
        status: UserStatus.Active,
        emailVerifiedAt: new Date(),
      }),
    );
    const secondToken = (await app.get(SessionService).create(secondAdmin))
      .accessToken;

    // The budget is per uploader, so a spent one must not deny a different admin.
    await request(app.getHttpServer())
      .post(`/api/v1/admin/rooms/${roomId}/images`)
      .set('Authorization', `Bearer ${secondToken}`)
      .field('associationType', 'ALBUM')
      .attach('file', pngBytes, { filename: 'second-admin.png' })
      .expect(201);
  });
});
