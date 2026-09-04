import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  AttachmentObjectType,
  StorageCleanupReason,
} from '../files/entities/attachment.enums';
import { Attachment } from '../files/entities/attachment.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { ListRoomsQueryDto } from './dto/list-rooms-query.dto';
import { CreateRoomDto, UpdateRoomDto } from './dto/room-request.dto';
import {
  AdminRoomResponseDto,
  PaginatedRoomsResponseDto,
} from './dto/room-response.dto';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import {
  findLockedReferences,
  toAmenityResponse,
  toRoomTypeResponse,
} from './reference-catalog.service';
import { hasDefinedUpdate } from './room-version';
import { isDatabaseError, roomsErrors } from './rooms.errors';

@Injectable()
export class RoomsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
  ) {}

  async create(body: CreateRoomDto): Promise<AdminRoomResponseDto> {
    await this.databaseConnection.ensureInitialized();
    try {
      return await this.dataSource.transaction(async (manager) => {
        const references = await findLockedReferences(
          manager,
          body.roomTypeId,
          body.amenityIds,
        );
        const room = await manager.save(
          manager.create(Room, {
            roomTypeId: references.roomType.id,
            roomNumber: body.roomNumber,
            bedCount: body.bedCount,
            viewCode: body.viewCode ?? null,
            basePriceAmount: String(body.basePriceAmount),
            currency: body.currency,
            status: body.status,
          }),
        );
        await replaceAmenityAssignments(manager, room.id, body.amenityIds);
        return toAdminRoomResponse(
          room,
          references.roomType,
          references.amenities,
        );
      });
    } catch (error) {
      if (isDatabaseError(error, 'ER_DUP_ENTRY')) {
        throw roomsErrors.roomNumberConflict();
      }
      throw error;
    }
  }

  async list(query: ListRoomsQueryDto): Promise<PaginatedRoomsResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const builder = this.dataSource
      .getRepository(Room)
      .createQueryBuilder('room')
      .innerJoinAndSelect('room.roomType', 'roomType');
    if (query.query?.trim()) {
      builder.andWhere(
        "(LOWER(room.room_number) LIKE :term ESCAPE '\\\\' OR LOWER(roomType.name) LIKE :term ESCAPE '\\\\')",
        { term: `%${escapeLike(query.query.trim().toLowerCase())}%` },
      );
    }
    if (query.status)
      builder.andWhere('room.status = :status', { status: query.status });
    if (query.roomTypeId) {
      builder.andWhere('room.room_type_id = :roomTypeId', {
        roomTypeId: query.roomTypeId,
      });
    }
    if (query.beds !== undefined) {
      builder.andWhere('room.bed_count = :beds', { beds: query.beds });
    }
    if (query.view?.trim()) {
      builder.andWhere('room.view_code = :view', {
        view: query.view.trim().toUpperCase(),
      });
    }
    const [rooms, total] = await builder
      .orderBy('room.id', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    const amenitiesByRoom = await loadAmenitiesByRoom(
      this.dataSource.manager,
      rooms.map((room) => room.id),
    );
    return {
      items: rooms.map((room) =>
        toAdminRoomResponse(
          room,
          room.roomType,
          amenitiesByRoom.get(room.id) ?? [],
        ),
      ),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(roomId: string): Promise<AdminRoomResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const room = await this.dataSource.getRepository(Room).findOne({
      where: { id: roomId },
      relations: { roomType: true },
    });
    if (!room) throw roomsErrors.roomNotFound();
    const amenitiesByRoom = await loadAmenitiesByRoom(this.dataSource.manager, [
      room.id,
    ]);
    return toAdminRoomResponse(
      room,
      room.roomType,
      amenitiesByRoom.get(room.id) ?? [],
    );
  }

  async update(
    roomId: string,
    expectedVersion: string,
    body: UpdateRoomDto,
  ): Promise<AdminRoomResponseDto> {
    if (!hasDefinedUpdate(body)) throw roomsErrors.emptyUpdate();
    await this.databaseConnection.ensureInitialized();
    try {
      return await this.dataSource.transaction(async (manager) => {
        // The row lock keeps the scalar update and complete amenity replacement in
        // one serial order; the caller's version still detects a stale admin form.
        const room = await manager.findOne(Room, {
          where: { id: roomId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!room) throw roomsErrors.roomNotFound();
        if (room.version !== expectedVersion) {
          throw roomsErrors.roomVersionConflict();
        }

        const currentAmenityIds =
          body.amenityIds ??
          (
            await manager.find(RoomAmenity, {
              where: { roomId },
              order: { amenityId: 'ASC' },
            })
          ).map((assignment) => assignment.amenityId);
        const references = await findLockedReferences(
          manager,
          body.roomTypeId ?? room.roomTypeId,
          currentAmenityIds,
        );

        if (body.roomNumber !== undefined) room.roomNumber = body.roomNumber;
        if (body.roomTypeId !== undefined) room.roomTypeId = body.roomTypeId;
        if (body.bedCount !== undefined) room.bedCount = body.bedCount;
        if (body.viewCode !== undefined) room.viewCode = body.viewCode;
        if (body.basePriceAmount !== undefined) {
          room.basePriceAmount = String(body.basePriceAmount);
        }
        if (body.currency !== undefined) room.currency = body.currency;
        if (body.status !== undefined) room.status = body.status;

        const saved = await manager.save(room);
        if (body.amenityIds !== undefined) {
          await replaceAmenityAssignments(manager, room.id, body.amenityIds);
        }
        return toAdminRoomResponse(
          saved,
          references.roomType,
          references.amenities,
        );
      });
    } catch (error) {
      if (isDatabaseError(error, 'ER_DUP_ENTRY')) {
        throw roomsErrors.roomNumberConflict();
      }
      throw error;
    }
  }

  async delete(roomId: string): Promise<void> {
    await this.databaseConnection.ensureInitialized();
    try {
      await this.dataSource.transaction(async (manager) => {
        const room = await manager.findOne(Room, {
          where: { id: roomId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!room) throw roomsErrors.roomNotFound();

        const attachments = await manager.find(Attachment, {
          where: { objectType: AttachmentObjectType.Room, objectId: roomId },
          lock: { mode: 'pessimistic_write' },
        });
        if (attachments.length) {
          await manager.delete(Attachment, {
            objectType: AttachmentObjectType.Room,
            objectId: roomId,
          });
          // Object storage is intentionally not called while holding DB locks.
          // P3-T05 consumes these durable, idempotent cleanup records after commit.
          await manager.insert(
            StorageCleanupTask,
            attachments.map((attachment) => ({
              id: randomUUID(),
              objectKey: attachment.objectKey,
              reason: StorageCleanupReason.DetachedObject,
              availableAt: new Date(),
              lockedAt: null,
              lockExpiresAt: null,
              lockedBy: null,
              attempts: 0,
            })),
          );
        }
        await manager.delete(RoomTime, { roomId });
        await manager.delete(RoomAmenity, { roomId });
        await manager.remove(room);
      });
    } catch (error) {
      // Phase 4 booking foreign keys will make this branch observable without
      // changing the Phase 3 API contract.
      if (isDatabaseError(error, 'ER_ROW_IS_REFERENCED_2')) {
        throw roomsErrors.roomHasHistory();
      }
      throw error;
    }
  }
}

async function replaceAmenityAssignments(
  manager: EntityManager,
  roomId: string,
  amenityIds: string[],
): Promise<void> {
  await manager.delete(RoomAmenity, { roomId });
  if (!amenityIds.length) return;
  await manager.insert(
    RoomAmenity,
    amenityIds.map((amenityId) => ({ roomId, amenityId })),
  );
}

async function loadAmenitiesByRoom(
  manager: EntityManager,
  roomIds: string[],
): Promise<Map<string, Amenity[]>> {
  const result = new Map<string, Amenity[]>();
  if (!roomIds.length) return result;
  const assignments = await manager.find(RoomAmenity, {
    where: { roomId: In(roomIds) },
    relations: { amenity: true },
    order: { roomId: 'ASC', amenityId: 'ASC' },
  });
  for (const assignment of assignments) {
    const roomAmenities = result.get(assignment.roomId) ?? [];
    roomAmenities.push(assignment.amenity);
    result.set(assignment.roomId, roomAmenities);
  }
  return result;
}

function toAdminRoomResponse(
  room: Room,
  roomType: RoomType,
  amenities: Amenity[],
): AdminRoomResponseDto {
  return {
    id: room.id,
    roomNumber: room.roomNumber,
    roomType: toRoomTypeResponse(roomType),
    bedCount: room.bedCount,
    viewCode: room.viewCode,
    basePriceAmount: Number(room.basePriceAmount),
    currency: room.currency,
    status: room.status,
    amenities: amenities.map(toAmenityResponse),
    version: Number(room.version),
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
