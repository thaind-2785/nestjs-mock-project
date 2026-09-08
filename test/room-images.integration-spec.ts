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
import { Attachment } from '../src/files/entities/attachment.entity';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
  StorageCleanupReason,
} from '../src/files/entities/attachment.enums';
import { StorageCleanupTask } from '../src/files/entities/storage-cleanup-task.entity';
import { CreateRoomDto } from '../src/rooms/dto/room-request.dto';
import { Amenity } from '../src/rooms/entities/amenity.entity';
import { RoomAmenity } from '../src/rooms/entities/room-amenity.entity';
import { RoomTime } from '../src/rooms/entities/room-time.entity';
import { RoomType } from '../src/rooms/entities/room-type.entity';
import { Room } from '../src/rooms/entities/room.entity';
import { RoomStatus } from '../src/rooms/entities/room.enums';
import { ReferenceCatalogService } from '../src/rooms/reference-catalog.service';
import { RoomSearchService } from '../src/rooms/room-search.service';
import { RoomsService } from '../src/rooms/rooms.service';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import {
  createRoomImageFixture,
  RoomImageFixture,
} from './fixtures/room-images';

jest.setTimeout(60_000);

const pngBytes = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(96, 0x21),
]);
const jpegBytes = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(96, 0x22),
]);

describe('Phase 3 room image persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let catalog: ReferenceCatalogService;
  let rooms: RoomsService;
  let search: RoomSearchService;
  let fixture: RoomImageFixture;
  let uploaderUserId: string;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p3_t05_int_${process.pid}_${randomUUID().replaceAll('-', '')}`;
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
        `Room image integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
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
    // A small album limit keeps the count-limit case cheap, and a short grace lets
    // the safeguard test observe the runner on both sides of the due time.
    fixture = createRoomImageFixture(dataSource, connection, environment, {
      roomImage: { maxBytes: 4_096, maxAlbumCount: 2 },
      storageTimeoutMs: 2_000,
      cleanupGraceMs: 1_200,
    });
    rooms = new RoomsService(dataSource, connection, fixture.images);
    search = new RoomSearchService(dataSource, connection, fixture.images);
    await fixture.ensureBucket();

    const uploader = await dataSource.manager.save(
      dataSource.manager.create(User, {
        email: 'room-images@example.com',
        displayName: 'Image Admin',
        role: UserRole.Admin,
        status: UserStatus.Active,
        emailVerifiedAt: new Date(),
      }),
    );
    uploaderUserId = uploader.id;
  });

  beforeEach(async () => {
    await deleteRemainingObjects();
    for (const table of [
      'attachments',
      'storage_cleanup_tasks',
      'room_times',
      'room_amenities',
      'rooms',
      'amenities',
      'room_types',
    ]) {
      await dataSource.query(`DELETE FROM ${table}`);
    }
  });

  afterAll(async () => {
    await deleteRemainingObjects().catch(() => undefined);
    fixture?.destroy();
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (adminConnection && disposableDatabase) {
      await adminConnection.query(
        `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
      );
      await adminConnection.end();
    }
  });

  /** Keeps MinIO free of objects this suite created, whatever a test asserted. */
  async function deleteRemainingObjects(): Promise<void> {
    if (!dataSource?.isInitialized) return;
    const keys = [
      ...(await dataSource.manager.find(Attachment)).map(
        ({ objectKey }) => objectKey,
      ),
      ...(await dataSource.manager.find(StorageCleanupTask)).map(
        ({ objectKey }) => objectKey,
      ),
    ];
    for (const objectKey of keys) {
      await fixture.storage.deleteObject(objectKey).catch(() => undefined);
    }
  }

  function roomInput(roomTypeId: string, roomNumber: string): CreateRoomDto {
    return {
      roomNumber,
      roomTypeId,
      bedCount: 2,
      viewCode: 'CITY',
      basePriceAmount: 1_500_000,
      currency: 'VND',
      status: RoomStatus.Active,
      amenityIds: [],
    };
  }

  async function createRoom(roomNumber: string): Promise<string> {
    const type = await catalog.createRoomType({ name: `Type ${roomNumber}` });
    const room = await rooms.create(roomInput(type.id, roomNumber));
    return room.id;
  }

  function upload(
    roomId: string,
    associationType: AttachmentAssociationType,
    body: Buffer = pngBytes,
    declaredMimeType = 'image/png',
  ) {
    return fixture.images.upload(roomId, {
      associationType,
      uploaderUserId,
      declaredMimeType,
      body,
    });
  }

  function readAttachments(roomId: string): Promise<Attachment[]> {
    return dataSource.manager.find(Attachment, {
      where: { objectType: AttachmentObjectType.Room, objectId: roomId },
      order: { associationType: 'ASC', position: 'ASC' },
    });
  }

  it('stores a thumbnail readable only through its presigned URL', async () => {
    const roomId = await createRoom('A-101');

    const image = await upload(roomId, AttachmentAssociationType.Thumbnail);

    expect(image).toMatchObject({
      associationType: 'THUMBNAIL',
      position: 0,
      mimeType: 'image/png',
      sizeBytes: pngBytes.byteLength,
    });
    expect(Object.keys(image).sort()).toEqual([
      'associationType',
      'expiresAt',
      'id',
      'mimeType',
      'position',
      'sizeBytes',
      'url',
    ]);
    // A presigned URL necessarily addresses the object, so the key appears in its
    // path. What must not appear is a credential, and the grant must expire. The
    // key itself is a random UUID, so one URL reveals no other object's address.
    const stored = await readAttachments(roomId);
    const url = new URL(image.url);
    expect(url.pathname).toBe(`/${fixture.bucket}/${stored[0].objectKey}`);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(
      String(fixture.configuration.presignTtlSeconds),
    );
    expect(image.url).not.toContain('local_minio_change_me');

    const response = await fetch(image.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(pngBytes);

    // The safeguard is retired by the commit that made the object live.
    expect(await dataSource.manager.count(StorageCleanupTask)).toBe(0);
  });

  it('replaces the thumbnail atomically and deletes the previous object', async () => {
    const roomId = await createRoom('A-102');
    const first = await upload(roomId, AttachmentAssociationType.Thumbnail);
    const [firstRow] = await readAttachments(roomId);

    const second = await upload(
      roomId,
      AttachmentAssociationType.Thumbnail,
      jpegBytes,
      'image/jpeg',
    );

    const rows = await readAttachments(roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: second.id, position: 0 });
    expect(rows[0].objectKey).not.toBe(firstRow.objectKey);
    expect(second.id).not.toBe(first.id);
    // Old object is gone and its cleanup task was retired by the same success.
    expect((await fetch(first.url)).status).toBe(404);
    expect(await dataSource.manager.count(StorageCleanupTask)).toBe(0);
  });

  it('appends album images to the configured limit and then rejects', async () => {
    const roomId = await createRoom('A-103');

    const first = await upload(roomId, AttachmentAssociationType.Album);
    const second = await upload(roomId, AttachmentAssociationType.Album);

    expect([first.position, second.position]).toEqual([0, 1]);
    await expect(
      upload(roomId, AttachmentAssociationType.Album),
    ).rejects.toMatchObject({ errorCode: 'ATTACHMENT_LIMIT_EXCEEDED' });

    // The rejected upload wrote an object, so its safeguard must survive as the
    // durable intent to delete it.
    const tasks = await dataSource.manager.find(StorageCleanupTask);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reason).toBe(StorageCleanupReason.UploadSafeguard);
    expect(await readAttachments(roomId)).toHaveLength(2);
  });

  it('keeps an in-flight safeguard until its grace passes, then deletes the orphan', async () => {
    const roomId = await createRoom('A-104');
    const policy = fixture.policies.resolve(
      AttachmentObjectType.Room,
      AttachmentAssociationType.Album,
    );
    // Everything the upload does before the metadata commit, which is exactly the
    // state a crash at that point leaves behind.
    const staged = await fixture.attachments.stageUpload({
      policy,
      objectId: roomId,
      declaredMimeType: 'image/png',
      body: pngBytes,
    });

    const early = await fixture.cleanup.run();
    expect(early).toEqual({ claimed: 0, deleted: 0, retryable: 0 });
    expect(await dataSource.manager.count(StorageCleanupTask)).toBe(1);
    const stillThere = await fetch(
      await fixture.storage.createPresignedGetUrl(staged.objectKey),
    );
    expect(stillThere.status).toBe(200);

    await new Promise((resolve) =>
      setTimeout(resolve, fixture.configuration.cleanupGraceMs + 200),
    );
    const drained = await fixture.cleanup.run();

    expect(drained).toEqual({ claimed: 1, deleted: 1, retryable: 0 });
    expect(await dataSource.manager.count(StorageCleanupTask)).toBe(0);
    const gone = await fetch(
      await fixture.storage.createPresignedGetUrl(staged.objectKey),
    );
    expect(gone.status).toBe(404);
  });

  it('retries a cleanup task whose provider call failed', async () => {
    const roomId = await createRoom('A-105');
    const image = await upload(roomId, AttachmentAssociationType.Album);
    const [row] = await readAttachments(roomId);
    await fixture.images.delete(roomId, image.id);
    // Re-queue the same key as due work and make the provider fail once.
    await dataSource.manager.insert(StorageCleanupTask, {
      id: randomUUID(),
      objectKey: row.objectKey,
      reason: StorageCleanupReason.DetachedObject,
      availableAt: new Date(Date.now() - 1_000),
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      attempts: 0,
    });
    const failing = jest
      .spyOn(fixture.storage, 'deleteObject')
      .mockRejectedValueOnce(new Error('provider unavailable'));

    const first = await fixture.cleanup.run();
    failing.mockRestore();

    expect(first).toEqual({ claimed: 1, deleted: 0, retryable: 1 });
    const [task] = await dataSource.manager.find(StorageCleanupTask);
    // The lease is released and the retry is delayed, but the intent survives.
    expect(task).toMatchObject({
      attempts: 1,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
    });
    expect(task.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('detaches one image by target tuple and keeps album positions contiguous', async () => {
    const roomId = await createRoom('A-106');
    const first = await upload(roomId, AttachmentAssociationType.Album);
    const second = await upload(roomId, AttachmentAssociationType.Album);

    await fixture.images.delete(roomId, first.id);

    const rows = await readAttachments(roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: second.id, position: 0 });
    expect((await fetch(first.url)).status).toBe(404);
  });

  it('refuses an attachment ID that belongs to another room', async () => {
    const roomId = await createRoom('A-107');
    const otherRoomId = await createRoom('A-108');
    const image = await upload(roomId, AttachmentAssociationType.Album);

    await expect(
      fixture.images.delete(otherRoomId, image.id),
    ).rejects.toMatchObject({ errorCode: 'ATTACHMENT_NOT_FOUND' });
    await expect(
      fixture.images.delete(roomId, randomUUID()),
    ).rejects.toMatchObject({ errorCode: 'ATTACHMENT_NOT_FOUND' });
    expect(await readAttachments(roomId)).toHaveLength(1);
  });

  it('reorders the complete album and rejects any other list', async () => {
    const roomId = await createRoom('A-109');
    const first = await upload(roomId, AttachmentAssociationType.Album);
    const second = await upload(roomId, AttachmentAssociationType.Album);

    const reordered = await fixture.images.reorder(roomId, [
      second.id,
      first.id,
    ]);

    expect(reordered.map(({ id, position }) => ({ id, position }))).toEqual([
      { id: second.id, position: 0 },
      { id: first.id, position: 1 },
    ]);

    for (const invalid of [
      [first.id],
      [first.id, first.id],
      [first.id, second.id, randomUUID()],
      [],
    ]) {
      await expect(
        fixture.images.reorder(roomId, invalid),
      ).rejects.toMatchObject({ errorCode: 'ATTACHMENT_ORDER_INVALID' });
    }
    // A rejected reorder leaves the accepted order untouched.
    const rows = await readAttachments(roomId);
    expect(rows.map(({ id }) => id)).toEqual([second.id, first.id]);
  });

  it('serializes concurrent album uploads on the physical room', async () => {
    const roomId = await createRoom('A-110');

    const results = await Promise.all([
      upload(roomId, AttachmentAssociationType.Album),
      upload(roomId, AttachmentAssociationType.Album),
    ]);

    // Without the room lock both uploads would compute the same next position and
    // one would violate the unique target/position key.
    expect(results.map(({ position }) => position).sort()).toEqual([0, 1]);
    expect(await readAttachments(roomId)).toHaveLength(2);
  });

  it('keeps exactly one thumbnail under concurrent replacement', async () => {
    const roomId = await createRoom('A-111');

    await Promise.all([
      upload(roomId, AttachmentAssociationType.Thumbnail),
      upload(
        roomId,
        AttachmentAssociationType.Thumbnail,
        jpegBytes,
        'image/jpeg',
      ),
    ]);

    const rows = await readAttachments(roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(0);
  });

  it('detaches media when the room is hard-deleted and the runner drains it', async () => {
    const roomId = await createRoom('A-112');
    const thumbnail = await upload(roomId, AttachmentAssociationType.Thumbnail);
    await upload(roomId, AttachmentAssociationType.Album);

    await rooms.delete(roomId);

    expect(await readAttachments(roomId)).toHaveLength(0);
    const tasks = await dataSource.manager.find(StorageCleanupTask);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.availableAt <= new Date())).toBe(true);

    const drained = await fixture.cleanup.run();
    expect(drained).toMatchObject({ claimed: 2, deleted: 2, retryable: 0 });
    expect((await fetch(thumbnail.url)).status).toBe(404);
  });

  it('publishes presigned reads through the admin and public room payloads', async () => {
    const roomId = await createRoom('A-113');
    await upload(roomId, AttachmentAssociationType.Thumbnail);
    const albumFirst = await upload(roomId, AttachmentAssociationType.Album);
    const albumSecond = await upload(roomId, AttachmentAssociationType.Album);
    await fixture.images.reorder(roomId, [albumSecond.id, albumFirst.id]);

    const admin = await rooms.get(roomId);
    expect(admin.thumbnail).toMatchObject({ associationType: 'THUMBNAIL' });
    expect(admin.images.map(({ id }) => id)).toEqual([
      albumSecond.id,
      albumFirst.id,
    ]);

    const detail = await search.get(roomId, {});
    // Public payloads carry only the short-lived read, in album order.
    expect(Object.keys(detail.thumbnail ?? {}).sort()).toEqual([
      'expiresAt',
      'url',
    ]);
    expect(detail.images).toHaveLength(2);
    for (const image of detail.images ?? []) {
      expect(Object.keys(image).sort()).toEqual(['expiresAt', 'url']);
    }
    expect((await fetch(detail.images?.[0].url ?? '')).status).toBe(200);

    const list = await search.search({ page: 1, pageSize: 20 });
    expect(list.items[0].thumbnail?.url ?? '').toContain('X-Amz-Signature');
    // The list carries the thumbnail only; the album belongs to detail.
    expect(list.items[0]).not.toHaveProperty('images');
  });
});
