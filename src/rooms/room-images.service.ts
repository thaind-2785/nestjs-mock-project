import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { AttachmentPolicyRegistry } from '../files/attachment-policy';
import {
  AttachmentRead,
  AttachmentsService,
} from '../files/attachments.service';
import { findAttachmentsByTargets } from '../files/attachment-metadata';
import { Attachment } from '../files/entities/attachment.entity';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from '../files/entities/attachment.enums';
import { RoomImageResponseDto } from './dto/room-image-response.dto';
import { Room } from './entities/room.entity';
import { lockRoom } from './room-lock';
import { roomsErrors } from './rooms.errors';

export interface RoomImageUpload {
  associationType: AttachmentAssociationType;
  uploaderUserId: string;
  declaredMimeType: string;
  body: Buffer;
}

export interface RoomImageSet {
  thumbnail: RoomImageResponseDto | null;
  album: RoomImageResponseDto[];
}

@Injectable()
export class RoomImagesService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly policies: AttachmentPolicyRegistry,
    private readonly attachments: AttachmentsService,
  ) {}

  public async upload(
    roomId: string,
    upload: RoomImageUpload,
  ): Promise<RoomImageResponseDto> {
    // The uploader's budget is charged by AttachmentUploadRateLimitGuard, before the
    // multipart body is read. Charging again here would spend two counters per
    // upload and halve the configured maximum.
    const policy = this.policies.resolve(
      AttachmentObjectType.Room,
      upload.associationType,
    );
    await this.databaseConnection.ensureInitialized();

    // A cheap existence check first, so an upload for an absent room does not write
    // an object at all. The authoritative check is the locked read below, which also
    // catches a room deleted while the object was being written.
    const roomExists = await this.dataSource.manager.exists(Room, {
      where: { id: roomId },
    });
    if (!roomExists) throw roomsErrors.roomNotFound();

    const staged = await this.attachments.stageUpload({
      policy,
      objectId: roomId,
      declaredMimeType: upload.declaredMimeType,
      body: upload.body,
    });

    // The object already exists at this point. If this transaction fails or the
    // process dies, the committed safeguard is the durable intent that deletes it.
    const commit = await this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      return this.attachments.completeUpload(
        manager,
        staged,
        upload.uploaderUserId,
      );
    });

    await this.attachments.deleteDetachedObjects(commit.detachedObjectKeys);
    const [read] = await this.attachments.createReads([commit.attachment]);
    return toRoomImageResponse(read);
  }

  public async reorder(
    roomId: string,
    attachmentIds: readonly string[],
  ): Promise<RoomImageResponseDto[]> {
    await this.databaseConnection.ensureInitialized();
    const ordered = await this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      return this.attachments.reorder(
        manager,
        {
          objectType: AttachmentObjectType.Room,
          objectId: roomId,
          associationType: AttachmentAssociationType.Album,
        },
        attachmentIds,
      );
    });

    return this.toRoomImageResponses(ordered);
  }

  public async delete(roomId: string, attachmentId: string): Promise<void> {
    await this.databaseConnection.ensureInitialized();
    const objectKey = await this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      return this.attachments.detach(manager, attachmentId, {
        objectType: AttachmentObjectType.Room,
        objectId: roomId,
      });
    });

    // Detachment and its cleanup task are already committed, so a provider failure
    // here changes nothing the caller can observe: the runner retries the delete.
    await this.attachments.deleteDetachedObjects([objectKey]);
  }

  /** Presigned image sets for a page of rooms, read inside the caller's snapshot. */
  public async loadImageSets(
    manager: EntityManager,
    roomIds: readonly string[],
  ): Promise<Map<string, RoomImageSet>> {
    const sets = new Map<string, RoomImageSet>();
    if (!roomIds.length) return sets;
    const [thumbnails, albums] = await Promise.all([
      findAttachmentsByTargets(
        manager,
        AttachmentObjectType.Room,
        roomIds,
        AttachmentAssociationType.Thumbnail,
      ),
      findAttachmentsByTargets(
        manager,
        AttachmentObjectType.Room,
        roomIds,
        AttachmentAssociationType.Album,
      ),
    ]);

    for (const roomId of roomIds) {
      const [thumbnail] = await this.toRoomImageResponses(
        thumbnails.get(roomId) ?? [],
      );
      sets.set(roomId, {
        thumbnail: thumbnail ?? null,
        album: await this.toRoomImageResponses(albums.get(roomId) ?? []),
      });
    }
    return sets;
  }

  /**
   * Public list responses expose only the thumbnail. Avoid signing every album
   * object on a page when the caller cannot see those URLs anyway.
   */
  public async loadThumbnails(
    manager: EntityManager,
    roomIds: readonly string[],
  ): Promise<Map<string, RoomImageSet>> {
    const sets = new Map<string, RoomImageSet>();
    if (!roomIds.length) return sets;

    const thumbnails = await findAttachmentsByTargets(
      manager,
      AttachmentObjectType.Room,
      roomIds,
      AttachmentAssociationType.Thumbnail,
    );
    for (const roomId of roomIds) {
      const [thumbnail] = await this.toRoomImageResponses(
        thumbnails.get(roomId) ?? [],
      );
      sets.set(roomId, { thumbnail: thumbnail ?? null, album: [] });
    }
    return sets;
  }

  private async toRoomImageResponses(
    attachments: readonly Attachment[],
  ): Promise<RoomImageResponseDto[]> {
    const reads = await this.attachments.createReads(attachments);
    return reads.map(toRoomImageResponse);
  }
}

function toRoomImageResponse(read: AttachmentRead): RoomImageResponseDto {
  return {
    id: read.id,
    associationType: read.associationType,
    position: read.position,
    mimeType: read.mimeType,
    sizeBytes: read.sizeBytes,
    url: read.url,
    expiresAt: read.expiresAt,
  };
}
