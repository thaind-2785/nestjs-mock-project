import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  RoomStayQueryDto,
  SearchRoomsQueryDto,
} from './dto/public-room-query.dto';
import {
  PaginatedPublicRoomsResponseDto,
  PublicAmenityResponseDto,
  PublicRoomResponseDto,
  PublicRoomTypeResponseDto,
} from './dto/public-room-response.dto';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { RoomStatus, RoomTimeStatus } from './entities/room.enums';
import { applyRoomAttributeFilters } from './room-filters';
import {
  assertPriceRange,
  resolveAmenityFilter,
  resolveStayRange,
  StayRange,
} from './room-search-policy';
import { loadAmenitiesByRoom } from './rooms.service';
import { roomsErrors } from './rooms.errors';

@Injectable()
export class RoomSearchService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
  ) {}

  async search(
    query: SearchRoomsQueryDto,
  ): Promise<PaginatedPublicRoomsResponseDto> {
    const stay = resolveStayRange(query);
    assertPriceRange(query);
    const amenityIds = resolveAmenityFilter(query.amenity);
    await this.databaseConnection.ensureInitialized();

    // One read-only snapshot: the page, its total, and the amenities of the
    // returned rooms must agree, or a room could be listed for a filter a
    // concurrent admin edit has already removed.
    return this.readSnapshot(async (manager) => {
      const builder = manager
        .getRepository(Room)
        .createQueryBuilder('room')
        .innerJoinAndSelect('room.roomType', 'roomType')
        .where('room.status = :roomStatus', { roomStatus: RoomStatus.Active });
      applyRoomAttributeFilters(builder, query);
      if (query.currency) {
        builder.andWhere('room.currency = :currency', {
          currency: query.currency,
        });
      }
      if (query.minPrice !== undefined) {
        builder.andWhere('room.base_price_amount >= :minPrice', {
          minPrice: query.minPrice,
        });
      }
      if (query.maxPrice !== undefined) {
        builder.andWhere('room.base_price_amount <= :maxPrice', {
          maxPrice: query.maxPrice,
        });
      }
      // Counting matched assignments in a correlated subquery keeps all-of
      // amenity semantics without joining, so no room is duplicated and `total`
      // stays exact.
      if (amenityIds.length) {
        builder.andWhere(
          (qb) =>
            `(${qb
              .subQuery()
              .select('COUNT(DISTINCT assignment.amenity_id)')
              .from(RoomAmenity, 'assignment')
              .where('assignment.room_id = room.id')
              .andWhere('assignment.amenity_id IN (:...amenityIds)')
              .getQuery()}) = :amenityCount`,
          { amenityIds, amenityCount: amenityIds.length },
        );
      }
      if (stay) {
        builder.andWhere(
          (qb) =>
            `EXISTS ${qb
              .subQuery()
              .select('1')
              .from(RoomTime, 'window')
              .where('window.room_id = room.id')
              .andWhere(stayContainmentCondition('window'))
              .getQuery()}`,
          stayContainmentParameters(stay),
        );
      }

      const [rooms, total] = await builder
        .orderBy('room.id', 'ASC')
        .skip((query.page - 1) * query.pageSize)
        .take(query.pageSize)
        .getManyAndCount();
      const amenitiesByRoom = await loadAmenitiesByRoom(
        manager,
        rooms.map((room) => room.id),
      );
      return {
        // Every returned room already satisfies the containment filter, so the
        // claim is only made when the caller supplied a stay.
        items: rooms.map((room) =>
          toPublicRoomResponse(
            room,
            room.roomType,
            amenitiesByRoom.get(room.id) ?? [],
            stay ? true : undefined,
          ),
        ),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    });
  }

  async get(
    roomId: string,
    query: RoomStayQueryDto,
  ): Promise<PublicRoomResponseDto> {
    const stay = resolveStayRange(query);
    await this.databaseConnection.ensureInitialized();
    return this.readSnapshot(async (manager) => {
      const room = await manager.getRepository(Room).findOne({
        where: { id: roomId, status: RoomStatus.Active },
        relations: { roomType: true },
      });
      // Inactive and maintenance rooms are indistinguishable from absent ones.
      if (!room) throw roomsErrors.roomNotFound();
      const [amenitiesByRoom, available] = await Promise.all([
        loadAmenitiesByRoom(manager, [room.id]),
        stay ? hasContainingWindow(manager, room.id, stay) : undefined,
      ]);
      return toPublicRoomResponse(
        room,
        room.roomType,
        amenitiesByRoom.get(room.id) ?? [],
        available,
      );
    });
  }

  private readSnapshot<T>(work: (manager: EntityManager) => Promise<T>) {
    return this.dataSource.transaction(work);
  }
}

/**
 * Phase 3 availability is window containment only: one active window must cover
 * the whole half-open stay. Phase 4 adds room-wide `CONFIRMED` exclusion to the
 * same condition, so it stays in one place.
 */
function stayContainmentCondition(alias: string): string {
  return `${alias}.status = :windowStatus AND ${alias}.available_from <= :checkIn AND ${alias}.available_to >= :checkOut`;
}

function stayContainmentParameters(stay: StayRange) {
  return {
    windowStatus: RoomTimeStatus.Active,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
  };
}

function hasContainingWindow(
  manager: EntityManager,
  roomId: string,
  stay: StayRange,
): Promise<boolean> {
  return manager
    .getRepository(RoomTime)
    .createQueryBuilder('window')
    .select('window.id')
    .where('window.room_id = :roomId', { roomId })
    .andWhere(
      stayContainmentCondition('window'),
      stayContainmentParameters(stay),
    )
    .limit(1)
    .getExists();
}

function toPublicRoomResponse(
  room: Room,
  roomType: RoomType,
  amenities: Amenity[],
  available: boolean | undefined,
): PublicRoomResponseDto {
  return {
    id: room.id,
    roomType: toPublicRoomTypeResponse(roomType),
    bedCount: room.bedCount,
    viewCode: room.viewCode,
    basePriceAmount: Number(room.basePriceAmount),
    currency: room.currency,
    amenities: amenities.map(toPublicAmenityResponse),
    ...(available === undefined ? {} : { available }),
  };
}

function toPublicRoomTypeResponse(
  roomType: RoomType,
): PublicRoomTypeResponseDto {
  return {
    id: roomType.id,
    name: roomType.name,
    description: roomType.description,
  };
}

function toPublicAmenityResponse(amenity: Amenity): PublicAmenityResponseDto {
  return { id: amenity.id, code: amenity.code, name: amenity.name };
}
