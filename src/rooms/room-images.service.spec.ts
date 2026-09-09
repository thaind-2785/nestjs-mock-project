import { DataSource, EntityManager } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { AttachmentPolicyRegistry } from '../files/attachment-policy';
import { AttachmentsService } from '../files/attachments.service';
import { Attachment } from '../files/entities/attachment.entity';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from '../files/entities/attachment.enums';
import { RoomImagesService } from './room-images.service';

describe('RoomImagesService read batching', () => {
  it('signs all detail thumbnails and albums for a page in one batch', async () => {
    const thumbnailOne = attachment('thumbnail-one', 'room-1', 'THUMBNAIL', 0);
    const thumbnailTwo = attachment('thumbnail-two', 'room-2', 'THUMBNAIL', 0);
    const albumOne = attachment('album-one', 'room-1', 'ALBUM', 0);
    const albumTwo = attachment('album-two', 'room-1', 'ALBUM', 1);
    const createReads = jest.fn((attachments: readonly Attachment[]) =>
      Promise.resolve(attachments.map(toRead)),
    );
    const service = createService(createReads);
    const manager = createReadManager({
      thumbnails: [thumbnailOne, thumbnailTwo],
      albums: [albumOne, albumTwo],
    });

    const sets = await service.loadImageSets(manager, ['room-1', 'room-2']);

    expect(createReads).toHaveBeenCalledTimes(1);
    expect(createReads).toHaveBeenCalledWith([
      thumbnailOne,
      thumbnailTwo,
      albumOne,
      albumTwo,
    ]);
    expect(sets.get('room-1')).toMatchObject({
      thumbnail: { id: 'thumbnail-one' },
      album: [{ id: 'album-one' }, { id: 'album-two' }],
    });
    expect(sets.get('room-2')).toMatchObject({
      thumbnail: { id: 'thumbnail-two' },
      album: [],
    });
  });

  it('signs public-list thumbnails in one batch', async () => {
    const thumbnailOne = attachment('thumbnail-one', 'room-1', 'THUMBNAIL', 0);
    const thumbnailTwo = attachment('thumbnail-two', 'room-2', 'THUMBNAIL', 0);
    const createReads = jest.fn((attachments: readonly Attachment[]) =>
      Promise.resolve(attachments.map(toRead)),
    );
    const service = createService(createReads);
    const manager = createReadManager({
      thumbnails: [thumbnailOne, thumbnailTwo],
      albums: [],
    });

    const sets = await service.loadThumbnails(manager, ['room-1', 'room-2']);

    expect(createReads).toHaveBeenCalledTimes(1);
    expect(createReads).toHaveBeenCalledWith([thumbnailOne, thumbnailTwo]);
    expect(sets.get('room-1')).toMatchObject({
      thumbnail: { id: 'thumbnail-one' },
      album: [],
    });
    expect(sets.get('room-2')).toMatchObject({
      thumbnail: { id: 'thumbnail-two' },
      album: [],
    });
  });
});

function createService(createReads: jest.Mock): RoomImagesService {
  return new RoomImagesService(
    {} as DataSource,
    {} as DatabaseConnectionService,
    {} as AttachmentPolicyRegistry,
    { createReads } as unknown as AttachmentsService,
  );
}

function createReadManager(input: {
  thumbnails: Attachment[];
  albums: Attachment[];
}): EntityManager {
  return {
    find: jest.fn(
      (
        _target: unknown,
        options: { where: { associationType: AttachmentAssociationType } },
      ) =>
        Promise.resolve(
          options.where.associationType === AttachmentAssociationType.Thumbnail
            ? input.thumbnails
            : input.albums,
        ),
    ),
  } as unknown as EntityManager;
}

function attachment(
  id: string,
  objectId: string,
  associationType: 'THUMBNAIL' | 'ALBUM',
  position: number,
): Attachment {
  return {
    id,
    objectId,
    associationType,
    objectType: AttachmentObjectType.Room,
    objectKey: `attachments/room/${objectId}/${associationType}/${id}.png`,
    mimeType: 'image/png',
    position,
    sizeBytes: '100',
  } as Attachment;
}

function toRead(attachment: Attachment) {
  return {
    id: attachment.id,
    associationType: attachment.associationType,
    position: attachment.position,
    mimeType: attachment.mimeType,
    sizeBytes: Number(attachment.sizeBytes),
    url: `https://storage.example/${attachment.id}`,
    expiresAt: '2026-09-09T00:00:00.000Z',
  };
}
