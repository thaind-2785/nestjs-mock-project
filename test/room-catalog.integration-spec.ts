import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { CreateAuthRbacSchema1788380000000 } from '../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from '../src/database/migrations/1788490000000-CreateRoomCatalogSchema';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
  StorageCleanupReason,
} from '../src/files/entities/attachment.enums';
import { Attachment } from '../src/files/entities/attachment.entity';
import { StorageCleanupTask } from '../src/files/entities/storage-cleanup-task.entity';
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus, RoomTimeStatus } from '../src/rooms/entities/room.enums';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';

jest.setTimeout(30_000);

describe('Phase 3 room catalog persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t01_${process.pid}_${randomUUID().replaceAll('-', '')}`;

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
        `Room catalog integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM storage_cleanup_tasks');
    await dataSource.query('DELETE FROM attachments');
    await dataSource.query('DELETE FROM room_times');
    await dataSource.query('DELETE FROM room_amenities');
    await dataSource.query('DELETE FROM rooms');
    await dataSource.query('DELETE FROM amenities');
    await dataSource.query('DELETE FROM room_types');
    await dataSource.query('DELETE FROM user_role_history');
    await dataSource.query('DELETE FROM user_status_history');
    await dataSource.query('DELETE FROM auth_sessions');
    await dataSource.query('DELETE FROM auth_identities');
    await dataSource.query('DELETE FROM users');
  });

  it('creates the complete Phase 3 schema with synchronize disabled', async () => {
    expect(dataSource.options.synchronize).toBe(false);
    const tables = await dataSource.query<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.tables
       WHERE table_schema = DATABASE() AND TABLE_NAME IN
       ('room_types','amenities','rooms','room_amenities','room_times','attachments','storage_cleanup_tasks')
       ORDER BY TABLE_NAME`,
    );

    expect(tables.map((row) => row.TABLE_NAME)).toEqual([
      'amenities',
      'attachments',
      'room_amenities',
      'room_times',
      'room_types',
      'rooms',
      'storage_cleanup_tasks',
    ]);
  });

  it('round-trips the catalog graph and inherited timestamps', async () => {
    const { roomType, amenity, room, user } = await createCatalogGraph();
    const assignment = await dataSource.getRepository(RoomAmenity).save(
      dataSource.getRepository(RoomAmenity).create({
        roomId: room.id,
        amenityId: amenity.id,
      }),
    );
    const window = await dataSource.getRepository(RoomTime).save(
      dataSource.getRepository(RoomTime).create({
        roomId: room.id,
        availableFrom: '2026-10-01',
        availableTo: '2026-11-01',
        status: RoomTimeStatus.Active,
      }),
    );
    const attachment = await dataSource.getRepository(Attachment).save(
      dataSource.getRepository(Attachment).create({
        id: randomUUID(),
        uploaderUserId: user.id,
        objectType: AttachmentObjectType.Room,
        objectId: room.id,
        associationType: AttachmentAssociationType.Thumbnail,
        position: 0,
        objectKey: `rooms/${room.id}/${randomUUID()}.webp`,
        mimeType: 'image/webp',
        sizeBytes: '1024',
      }),
    );

    expect(roomType.createdAt).toBeInstanceOf(Date);
    expect(room.version).toBe('1');
    expect(room.basePriceAmount).toBe('1500000');
    expect(assignment.createdAt).toBeInstanceOf(Date);
    expect(window.availableFrom).toBe('2026-10-01');
    expect(attachment.objectId).toBe(room.id);
  });

  it('enforces room, window, attachment, and cleanup safeguards', async () => {
    const { roomType, room, user } = await createCatalogGraph();

    await expect(
      dataSource.getRepository(Room).insert({
        roomTypeId: roomType.id,
        roomNumber: room.roomNumber,
        bedCount: 2,
        basePriceAmount: '1000',
        currency: 'VND',
        status: RoomStatus.Active,
      }),
    ).rejects.toBeDefined();
    await expect(
      dataSource.getRepository(RoomTime).insert({
        roomId: room.id,
        availableFrom: '2026-11-01',
        availableTo: '2026-11-01',
        status: RoomTimeStatus.Active,
      }),
    ).rejects.toBeDefined();

    const firstAttachment = attachmentFixture(room.id, user.id, 0);
    await dataSource.getRepository(Attachment).insert(firstAttachment);
    await expect(
      dataSource
        .getRepository(Attachment)
        .insert(attachmentFixture(room.id, user.id, 0)),
    ).rejects.toBeDefined();

    await dataSource.getRepository(StorageCleanupTask).insert({
      id: randomUUID(),
      objectKey: `rooms/${room.id}/pending.webp`,
      reason: StorageCleanupReason.UploadSafeguard,
      availableAt: new Date(Date.now() + 60_000),
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      attempts: 0,
    });
    await expect(
      dataSource.getRepository(StorageCleanupTask).insert({
        id: randomUUID(),
        objectKey: `rooms/${room.id}/invalid-lock.webp`,
        reason: StorageCleanupReason.DetachedObject,
        availableAt: new Date(),
        lockedAt: new Date(),
        lockExpiresAt: null,
        lockedBy: null,
        attempts: 1,
      }),
    ).rejects.toBeDefined();
  });

  it('reverts only the Phase 3 schema and reapplies it cleanly', async () => {
    await dataSource.undoLastMigration();
    const tables = await dataSource.query<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.tables
       WHERE table_schema = DATABASE() AND TABLE_NAME IN ('users','rooms','attachments')
       ORDER BY TABLE_NAME`,
    );
    expect(tables.map((row) => row.TABLE_NAME)).toEqual(['users']);

    await dataSource.runMigrations();
  });

  async function createCatalogGraph(): Promise<{
    roomType: RoomType;
    amenity: Amenity;
    room: Room;
    user: User;
  }> {
    const roomType = await dataSource.getRepository(RoomType).save({
      name: 'Deluxe',
      description: 'Deluxe room',
    });
    const amenity = await dataSource.getRepository(Amenity).save({
      code: 'WIFI',
      name: 'Wi-Fi',
    });
    const room = await dataSource.getRepository(Room).save({
      roomTypeId: roomType.id,
      roomNumber: 'A-201',
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: '1500000',
      currency: 'VND',
      status: RoomStatus.Active,
    });
    const user = await dataSource.getRepository(User).save({
      email: 'uploader@example.com',
      displayName: 'Uploader',
      role: UserRole.Admin,
      status: UserStatus.Active,
      emailVerifiedAt: new Date(),
    });
    return { roomType, amenity, room, user };
  }

  function attachmentFixture(
    roomId: string,
    uploaderUserId: string,
    position: number,
  ): Partial<Attachment> {
    return {
      id: randomUUID(),
      uploaderUserId,
      objectType: AttachmentObjectType.Room,
      objectId: roomId,
      associationType: AttachmentAssociationType.Album,
      position,
      objectKey: `rooms/${roomId}/${randomUUID()}.webp`,
      mimeType: 'image/webp',
      sizeBytes: '1024',
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
