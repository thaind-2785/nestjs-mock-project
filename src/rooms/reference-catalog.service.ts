import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  CreateAmenityDto,
  CreateRoomTypeDto,
  UpdateAmenityDto,
  UpdateRoomTypeDto,
} from './dto/reference-catalog.dto';
import { ReferenceCatalogQueryDto } from './dto/pagination-query.dto';
import {
  AmenityResponseDto,
  PaginatedAmenitiesResponseDto,
  PaginatedRoomTypesResponseDto,
  RoomTypeResponseDto,
} from './dto/room-response.dto';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { hasDefinedUpdate } from './room-version';
import { isDatabaseError, roomsErrors } from './rooms.errors';

@Injectable()
export class ReferenceCatalogService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
  ) {}

  async createRoomType(body: CreateRoomTypeDto): Promise<RoomTypeResponseDto> {
    await this.databaseConnection.ensureInitialized();
    try {
      const roomType = await this.dataSource.getRepository(RoomType).save({
        name: body.name,
        description: body.description || null,
      });
      return toRoomTypeResponse(roomType);
    } catch (error) {
      if (isDatabaseError(error, 'ER_DUP_ENTRY')) {
        throw roomsErrors.roomTypeNameConflict();
      }
      throw error;
    }
  }

  async listRoomTypes(
    query: ReferenceCatalogQueryDto,
  ): Promise<PaginatedRoomTypesResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const builder = this.dataSource
      .getRepository(RoomType)
      .createQueryBuilder('roomType');
    if (query.query?.trim()) {
      builder.andWhere("LOWER(roomType.name) LIKE :term ESCAPE '\\\\'", {
        term: `%${escapeLike(query.query.trim().toLowerCase())}%`,
      });
    }
    const [items, total] = await builder
      .orderBy('roomType.id', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: items.map(toRoomTypeResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getRoomType(roomTypeId: string): Promise<RoomTypeResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const roomType = await this.dataSource
      .getRepository(RoomType)
      .findOneBy({ id: roomTypeId });
    if (!roomType) throw roomsErrors.roomTypeNotFound();
    return toRoomTypeResponse(roomType);
  }

  async updateRoomType(
    roomTypeId: string,
    body: UpdateRoomTypeDto,
  ): Promise<RoomTypeResponseDto> {
    if (!hasDefinedUpdate(body)) throw roomsErrors.emptyUpdate();
    await this.databaseConnection.ensureInitialized();
    try {
      return await this.dataSource.transaction(async (manager) => {
        const roomType = await manager.findOne(RoomType, {
          where: { id: roomTypeId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!roomType) throw roomsErrors.roomTypeNotFound();
        if (body.name !== undefined) roomType.name = body.name;
        if (body.description !== undefined) {
          roomType.description = body.description || null;
        }
        return toRoomTypeResponse(await manager.save(roomType));
      });
    } catch (error) {
      if (isDatabaseError(error, 'ER_DUP_ENTRY')) {
        throw roomsErrors.roomTypeNameConflict();
      }
      throw error;
    }
  }

  async deleteRoomType(roomTypeId: string): Promise<void> {
    await this.databaseConnection.ensureInitialized();
    try {
      await this.dataSource.transaction(async (manager) => {
        const roomType = await manager.findOne(RoomType, {
          where: { id: roomTypeId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!roomType) throw roomsErrors.roomTypeNotFound();
        if (await manager.count(Room, { where: { roomTypeId } })) {
          throw roomsErrors.roomTypeInUse();
        }
        await manager.remove(roomType);
      });
    } catch (error) {
      if (isDatabaseError(error, 'ER_ROW_IS_REFERENCED_2')) {
        throw roomsErrors.roomTypeInUse();
      }
      throw error;
    }
  }

  async createAmenity(body: CreateAmenityDto): Promise<AmenityResponseDto> {
    await this.databaseConnection.ensureInitialized();
    try {
      const amenity = await this.dataSource.getRepository(Amenity).save({
        code: body.code,
        name: body.name,
      });
      return toAmenityResponse(amenity);
    } catch (error) {
      if (isDatabaseError(error, 'ER_DUP_ENTRY')) {
        throw roomsErrors.amenityCodeConflict();
      }
      throw error;
    }
  }

  async listAmenities(
    query: ReferenceCatalogQueryDto,
  ): Promise<PaginatedAmenitiesResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const builder = this.dataSource
      .getRepository(Amenity)
      .createQueryBuilder('amenity');
    if (query.query?.trim()) {
      builder.andWhere(
        "(LOWER(amenity.code) LIKE :term ESCAPE '\\\\' OR LOWER(amenity.name) LIKE :term ESCAPE '\\\\')",
        { term: `%${escapeLike(query.query.trim().toLowerCase())}%` },
      );
    }
    const [items, total] = await builder
      .orderBy('amenity.id', 'ASC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: items.map(toAmenityResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getAmenity(amenityId: string): Promise<AmenityResponseDto> {
    await this.databaseConnection.ensureInitialized();
    const amenity = await this.dataSource
      .getRepository(Amenity)
      .findOneBy({ id: amenityId });
    if (!amenity) throw roomsErrors.amenityNotFound();
    return toAmenityResponse(amenity);
  }

  async updateAmenity(
    amenityId: string,
    body: UpdateAmenityDto,
  ): Promise<AmenityResponseDto> {
    if (!hasDefinedUpdate(body)) throw roomsErrors.emptyUpdate();
    await this.databaseConnection.ensureInitialized();
    try {
      return await this.dataSource.transaction(async (manager) => {
        const amenity = await manager.findOne(Amenity, {
          where: { id: amenityId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!amenity) throw roomsErrors.amenityNotFound();
        if (body.code !== undefined) amenity.code = body.code;
        if (body.name !== undefined) amenity.name = body.name;
        return toAmenityResponse(await manager.save(amenity));
      });
    } catch (error) {
      if (isDatabaseError(error, 'ER_DUP_ENTRY')) {
        throw roomsErrors.amenityCodeConflict();
      }
      throw error;
    }
  }

  async deleteAmenity(amenityId: string): Promise<void> {
    await this.databaseConnection.ensureInitialized();
    try {
      await this.dataSource.transaction(async (manager) => {
        const amenity = await manager.findOne(Amenity, {
          where: { id: amenityId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!amenity) throw roomsErrors.amenityNotFound();
        if (await manager.count(RoomAmenity, { where: { amenityId } })) {
          throw roomsErrors.amenityInUse();
        }
        await manager.remove(amenity);
      });
    } catch (error) {
      if (isDatabaseError(error, 'ER_ROW_IS_REFERENCED_2')) {
        throw roomsErrors.amenityInUse();
      }
      throw error;
    }
  }
}

export function toRoomTypeResponse(roomType: RoomType): RoomTypeResponseDto {
  return {
    id: roomType.id,
    name: roomType.name,
    description: roomType.description,
    createdAt: roomType.createdAt.toISOString(),
    updatedAt: roomType.updatedAt.toISOString(),
  };
}

export function toAmenityResponse(amenity: Amenity): AmenityResponseDto {
  return {
    id: amenity.id,
    code: amenity.code,
    name: amenity.name,
    createdAt: amenity.createdAt.toISOString(),
    updatedAt: amenity.updatedAt.toISOString(),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export async function findLockedReferences(
  manager: EntityManager,
  roomTypeId: string,
  amenityIds: string[],
): Promise<{ roomType: RoomType; amenities: Amenity[] }> {
  const roomType = await manager.findOne(RoomType, {
    where: { id: roomTypeId },
    lock: { mode: 'pessimistic_read' },
  });
  if (!roomType) throw roomsErrors.roomReferenceNotFound();

  const amenities = amenityIds.length
    ? await manager
        .createQueryBuilder(Amenity, 'amenity')
        .setLock('pessimistic_read')
        .where('amenity.id IN (:...amenityIds)', { amenityIds })
        .orderBy('amenity.id', 'ASC')
        .getMany()
    : [];
  if (amenities.length !== amenityIds.length) {
    throw roomsErrors.roomReferenceNotFound();
  }
  return { roomType, amenities };
}
