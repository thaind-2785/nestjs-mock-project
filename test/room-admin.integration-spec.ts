import { randomUUID } from 'node:crypto';
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
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from '../src/files/entities/attachment.enums';
import { Attachment } from '../src/files/entities/attachment.entity';
import { StorageCleanupTask } from '../src/files/entities/storage-cleanup-task.entity';
import { ListRoomsQueryDto } from '../src/rooms/dto/list-rooms-query.dto';
import { ReferenceCatalogQueryDto } from '../src/rooms/dto/pagination-query.dto';
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { ReferenceCatalogService } from '../src/rooms/reference-catalog.service';
import { RoomsService } from '../src/rooms/rooms.service';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';

jest.setTimeout(30_000);

describe('P3-T02 room administration persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let catalog: ReferenceCatalogService;
  let rooms: RoomsService;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t02_${process.pid}_${randomUUID().replaceAll('-', '')}`;
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
        `Room admin integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
          ],
          migrations: [
            CreateAuthRbacSchema1788380000000,
            CreateRoomCatalogSchema1788490000000,
          ],
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();
    const connection = new DatabaseConnectionService(dataSource);
    catalog = new ReferenceCatalogService(dataSource, connection);
    rooms = new RoomsService(dataSource, connection);
  });

  beforeEach(async () => {
    for (const table of [
      'storage_cleanup_tasks',
      'attachments',
      'room_times',
      'room_amenities',
      'rooms',
      'amenities',
      'room_types',
      'user_role_history',
      'user_status_history',
      'auth_sessions',
      'auth_identities',
      'users',
    ]) {
      await dataSource.query(`DELETE FROM ${table}`);
    }
  });

  it('manages searchable reference catalogs and protects in-use rows', async () => {
    const deluxe = await catalog.createRoomType({
      name: 'Deluxe',
      description: 'City rooms',
    });
    const wifi = await catalog.createAmenity({ code: 'WIFI', name: 'Wi-Fi' });
    expect(
      await catalog.listRoomTypes(new ReferenceCatalogQueryDto()),
    ).toMatchObject({
      items: [{ id: deluxe.id, name: 'Deluxe' }],
      total: 1,
    });
    expect(
      await catalog.listAmenities(
        Object.assign(new ReferenceCatalogQueryDto(), { query: 'wi' }),
      ),
    ).toMatchObject({ items: [{ id: wifi.id, code: 'WIFI' }], total: 1 });

    await expect(
      catalog.createRoomType({ name: 'deluxe', description: null }),
    ).rejects.toMatchObject({ errorCode: 'ROOM_TYPE_NAME_CONFLICT' });
    await expect(
      catalog.createAmenity({ code: 'wifi', name: 'Duplicate' }),
    ).rejects.toMatchObject({ errorCode: 'AMENITY_CODE_CONFLICT' });

    await rooms.create(roomInput(deluxe.id, [wifi.id], 'A-201'));
    await expect(catalog.deleteRoomType(deluxe.id)).rejects.toMatchObject({
      errorCode: 'ROOM_TYPE_IN_USE',
    });
    await expect(catalog.deleteAmenity(wifi.id)).rejects.toMatchObject({
      errorCode: 'AMENITY_IN_USE',
    });
  });

  it('creates, filters, and atomically version-updates rooms', async () => {
    const deluxe = await catalog.createRoomType({ name: 'Deluxe' });
    const suite = await catalog.createRoomType({ name: 'Suite' });
    const wifi = await catalog.createAmenity({ code: 'WIFI', name: 'Wi-Fi' });
    const pool = await catalog.createAmenity({ code: 'POOL', name: 'Pool' });
    const created = await rooms.create(
      roomInput(deluxe.id, [wifi.id], 'A-201'),
    );
    expect(created).toMatchObject({
      roomNumber: 'A-201',
      roomType: { id: deluxe.id },
      amenities: [{ id: wifi.id }],
      version: 1,
    });
    await expect(
      rooms.create(roomInput(suite.id, [pool.id], 'A-201')),
    ).rejects.toMatchObject({ errorCode: 'ROOM_NUMBER_CONFLICT' });

    const filtered = await rooms.list(
      Object.assign(new ListRoomsQueryDto(), {
        query: 'delux',
        status: RoomStatus.Active,
        roomTypeId: deluxe.id,
        beds: 2,
        view: 'city',
      }),
    );
    expect(filtered).toMatchObject({ total: 1, items: [{ id: created.id }] });

    const attempts = await Promise.allSettled([
      rooms.update(created.id, '1', {
        roomTypeId: suite.id,
        amenityIds: [pool.id],
        viewCode: null,
      }),
      rooms.update(created.id, '1', { roomNumber: 'A-201-REVISED' }),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      errorCode: 'ROOM_VERSION_CONFLICT',
    });
    const current = await rooms.get(created.id);
    expect(current.version).toBe(2);

    await expect(
      rooms.update(created.id, '2', { amenityIds: ['999999999'] }),
    ).rejects.toMatchObject({ errorCode: 'ROOM_REFERENCE_NOT_FOUND' });
    expect((await rooms.get(created.id)).version).toBe(2);
  });

  it('hard-deletes the room graph and persists attachment cleanup atomically', async () => {
    const deluxe = await catalog.createRoomType({ name: 'Deluxe' });
    const wifi = await catalog.createAmenity({ code: 'WIFI', name: 'Wi-Fi' });
    const room = await rooms.create(roomInput(deluxe.id, [wifi.id], 'A-201'));
    const uploader = await dataSource.getRepository(User).save({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: UserRole.Admin,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    await dataSource.getRepository(RoomTime).save({
      roomId: room.id,
      availableFrom: '2026-10-01',
      availableTo: '2026-11-01',
      status: RoomTimeStatus.Active,
    });
    const objectKey = `rooms/${room.id}/${randomUUID()}.webp`;
    await dataSource.getRepository(Attachment).save({
      id: randomUUID(),
      uploaderUserId: uploader.id,
      objectType: AttachmentObjectType.Room,
      objectId: room.id,
      associationType: AttachmentAssociationType.Thumbnail,
      position: 0,
      objectKey,
      mimeType: 'image/webp',
      sizeBytes: '1024',
    });

    await rooms.delete(room.id);

    expect(await dataSource.getRepository(Room).count()).toBe(0);
    expect(await dataSource.getRepository(RoomAmenity).count()).toBe(0);
    expect(await dataSource.getRepository(RoomTime).count()).toBe(0);
    expect(await dataSource.getRepository(Attachment).count()).toBe(0);
    expect(
      await dataSource
        .getRepository(StorageCleanupTask)
        .findOneByOrFail({ objectKey }),
    ).toMatchObject({
      objectKey,
      reason: 'DETACHED_OBJECT',
    });
    await expect(catalog.deleteRoomType(deluxe.id)).resolves.toBeUndefined();
    await expect(catalog.deleteAmenity(wifi.id)).resolves.toBeUndefined();
  });

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
