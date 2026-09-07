import { Injectable } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  PaginatedPublicRoomsResponseDto,
  PublicRoomResponseDto,
} from './dto/public-room-response.dto';
import {
  RoomStayQueryDto,
  SearchRoomsQueryDto,
} from './dto/public-room-query.dto';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { RoomStatus, RoomTimeStatus } from './entities/room.enums';
import {
  toAmenityResponse,
  toRoomTypeResponse,
} from './reference-catalog.service';
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

    const builder = this.dataSource
      .getRepository(Room)
      .createQueryBuilder('room')
      .innerJoinAndSelect('room.roomType', 'roomType')
      .where('room.status = :roomStatus', { roomStatus: RoomStatus.Active });
    if (query.roomTypeId) {
      builder.andWhere('room.room_type_id = :roomTypeId', {
        roomTypeId: query.roomTypeId,
      });
    }
    if (query.beds !== undefined) {
      builder.andWhere('room.bed_count = :beds', { beds: query.beds });
    }
    if (query.view) {
      builder.andWhere('room.view_code = :view', { view: query.view });
    }
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
    // Counting matched assignments in a correlated subquery keeps all-of amenity
    // semantics without joining, so no room is duplicated and `total` stays exact.
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
    if (stay) applyStayContainment(builder, stay);

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
  }

  async get(
    roomId: string,
    query: RoomStayQueryDto,
  ): Promise<PublicRoomResponseDto> {
    const stay = resolveStayRange(query);
    await this.databaseConnection.ensureInitialized();
    const room = await this.dataSource.getRepository(Room).findOne({
      where: { id: roomId, status: RoomStatus.Active },
      relations: { roomType: true },
    });
    // Inactive and maintenance rooms are indistinguishable from absent ones.
    if (!room) throw roomsErrors.roomNotFound();
    const amenitiesByRoom = await loadAmenitiesByRoom(this.dataSource.manager, [
      room.id,
    ]);
    const available = stay
      ? await this.hasContainingWindow(room.id, stay)
      : undefined;
    return toPublicRoomResponse(
      room,
      room.roomType,
      amenitiesByRoom.get(room.id) ?? [],
      available,
    );
  }

  private async hasContainingWindow(
    roomId: string,
    stay: StayRange,
  ): Promise<boolean> {
    const builder = this.dataSource
      .getRepository(Room)
      .createQueryBuilder('room')
      .select('room.id')
      .where('room.id = :roomId', { roomId })
      .limit(1);
    applyStayContainment(builder, stay);
    return (await builder.getOne()) !== null;
  }
}

/**
 * Phase 3 availability is window containment only: one active window must cover
 * the whole half-open stay. Phase 4 adds room-wide `CONFIRMED` exclusion to the
 * same predicate, so it stays in one place.
 */
function applyStayContainment(
  builder: SelectQueryBuilder<Room>,
  stay: StayRange,
): void {
  builder.andWhere(
    (qb) =>
      `EXISTS ${qb
        .subQuery()
        .select('1')
        .from(RoomTime, 'window')
        .where('window.room_id = room.id')
        .andWhere('window.status = :windowStatus')
        .andWhere('window.available_from <= :checkIn')
        .andWhere('window.available_to >= :checkOut')
        .getQuery()}`,
    {
      windowStatus: RoomTimeStatus.Active,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
    },
  );
}

function toPublicRoomResponse(
  room: Room,
  roomType: RoomType,
  amenities: Amenity[],
  available: boolean | undefined,
): PublicRoomResponseDto {
  return {
    id: room.id,
    roomType: toRoomTypeResponse(roomType),
    bedCount: room.bedCount,
    viewCode: room.viewCode,
    basePriceAmount: Number(room.basePriceAmount),
    currency: room.currency,
    amenities: amenities.map(toAmenityResponse),
    ...(available === undefined ? {} : { available }),
  };
}
