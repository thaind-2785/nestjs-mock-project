import { Injectable } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  ObjectLiteral,
  SelectQueryBuilder,
} from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  RoomStayQueryDto,
  SearchRoomsQueryDto,
} from './dto/public-room-query.dto';
import {
  PaginatedPublicRoomsResponseDto,
  PublicAmenityResponseDto,
  PublicRoomImageResponseDto,
  PublicRoomResponseDto,
  PublicRoomTypeResponseDto,
} from './dto/public-room-response.dto';
import { Amenity } from './entities/amenity.entity';
import { RoomAmenity } from './entities/room-amenity.entity';
import { RoomTime } from './entities/room-time.entity';
import { RoomType } from './entities/room-type.entity';
import { Room } from './entities/room.entity';
import { RoomStatus, RoomTimeStatus } from './entities/room.enums';
import {
  confirmedOverlapCondition,
  confirmedOverlapParameters,
} from '../bookings/booking-overlap';
import { Booking } from '../bookings/entities/booking.entity';
import { applyRoomAttributeFilters } from './room-filters';
import { RoomImageSet, RoomImagesService } from './room-images.service';
import {
  assertPriceRange,
  resolveAmenityFilter,
  resolveStayRange,
} from './room-search-policy';
import type { StayRange } from './room-search.types';
import { loadAmenitiesByRoom } from './rooms.service';
import { roomsErrors } from './rooms.errors';

@Injectable()
export class RoomSearchService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly images: RoomImagesService,
  ) {}

  public async search(
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
      const [rooms, total] = await this.buildSearchQuery(
        manager,
        query,
        amenityIds,
        stay,
      )
        .orderBy('room.id', 'ASC')
        .skip((query.page - 1) * query.pageSize)
        .take(query.pageSize)
        .getManyAndCount();
      const roomIds = rooms.map((room) => room.id);
      const [amenitiesByRoom, imagesByRoom] = await Promise.all([
        loadAmenitiesByRoom(manager, roomIds),
        this.images.loadThumbnails(manager, roomIds),
      ]);
      return {
        // Every returned room already satisfies the containment filter, so the
        // claim is only made when the caller supplied a stay.
        items: rooms.map((room) =>
          this.toPublicRoomResponse(
            room,
            room.roomType,
            amenitiesByRoom.get(room.id) ?? [],
            imagesByRoom.get(room.id),
            stay ? true : undefined,
          ),
        ),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    });
  }

  public async get(
    roomId: string,
    query: RoomStayQueryDto,
  ): Promise<PublicRoomResponseDto> {
    const stay = resolveStayRange(query);
    await this.databaseConnection.ensureInitialized();
    return this.readSnapshot(async (manager) => {
      const room = await manager.getRepository(Room).findOne({
        where: { id: roomId, status: RoomStatus.Active },
        select: {
          id: true,
          bedCount: true,
          viewCode: true,
          basePriceAmount: true,
          currency: true,
          roomType: { id: true, name: true, description: true },
        },
        relations: { roomType: true },
      });
      // Inactive and maintenance rooms are indistinguishable from absent ones.
      if (!room) throw roomsErrors.roomNotFound();
      const [amenitiesByRoom, imagesByRoom, available] = await Promise.all([
        loadAmenitiesByRoom(manager, [room.id]),
        this.images.loadImageSets(manager, [room.id]),
        stay ? this.isAvailableForStay(manager, room.id, stay) : undefined,
      ]);
      return this.toPublicRoomDetailResponse(
        room,
        room.roomType,
        amenitiesByRoom.get(room.id) ?? [],
        imagesByRoom.get(room.id),
        available,
      );
    });
  }

  private buildSearchQuery(
    manager: EntityManager,
    query: SearchRoomsQueryDto,
    amenityIds: string[],
    stay: StayRange | undefined,
  ): SelectQueryBuilder<Room> {
    const builder = manager
      .getRepository(Room)
      .createQueryBuilder('room')
      .innerJoin('room.roomType', 'roomType')
      // Public reads hydrate only the fields their explicit mapper publishes.
      // Predicate columns do not need to be part of the SELECT projection.
      .select([
        'room.id',
        'room.bedCount',
        'room.viewCode',
        'room.basePriceAmount',
        'room.currency',
        'roomType.id',
        'roomType.name',
        'roomType.description',
      ])
      .where('room.status = :roomStatus', {
        roomStatus: RoomStatus.Active,
      });

    applyRoomAttributeFilters(builder, query);
    this.applyPriceFilters(builder, query);
    this.applyAmenityFilter(builder, amenityIds);
    if (stay) this.applyStayContainment(builder, stay);
    return builder;
  }

  private applyPriceFilters(
    builder: SelectQueryBuilder<Room>,
    query: SearchRoomsQueryDto,
  ): void {
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
  }

  private applyAmenityFilter(
    builder: SelectQueryBuilder<Room>,
    amenityIds: string[],
  ): void {
    if (!amenityIds.length) return;
    // A correlated count keeps all-of semantics without duplicating rooms and
    // lets the page and total use exactly the same filter.
    builder.andWhere(
      (queryBuilder) =>
        `(${queryBuilder
          .subQuery()
          .select('COUNT(DISTINCT assignment.amenity_id)')
          .from(RoomAmenity, 'assignment')
          .where('assignment.room_id = room.id')
          .andWhere('assignment.amenity_id IN (:...amenityIds)')
          .getQuery()}) = :amenityCount`,
      { amenityIds, amenityCount: amenityIds.length },
    );
  }

  private applyStayContainment(
    builder: SelectQueryBuilder<Room>,
    stay: StayRange,
  ): void {
    builder
      .andWhere(
        (queryBuilder) =>
          `EXISTS ${queryBuilder
            .subQuery()
            .select('1')
            .from(RoomTime, 'window')
            .where('window.room_id = room.id')
            .andWhere(this.stayContainmentCondition('window'))
            .getQuery()}`,
        this.stayContainmentParameters(stay),
      )
      .andWhere(
        (queryBuilder) =>
          this.confirmedOverlapExclusion(queryBuilder, 'room.id'),
        confirmedOverlapParameters(stay),
      );
  }

  private isAvailableForStay(
    manager: EntityManager,
    roomId: string,
    stay: StayRange,
  ): Promise<boolean> {
    return (
      manager
        .getRepository(RoomTime)
        .createQueryBuilder('window')
        .select('window.id')
        .where('window.room_id = :roomId', { roomId })
        .andWhere(
          this.stayContainmentCondition('window'),
          this.stayContainmentParameters(stay),
        )
        // The exclusion correlates to the bound room ID rather than to a joined
        // column, so detail asks the same question as the list without needing
        // the list's `room` alias in scope.
        .andWhere(
          (queryBuilder) =>
            this.confirmedOverlapExclusion(queryBuilder, ':roomId'),
          confirmedOverlapParameters(stay),
        )
        .limit(1)
        .getExists()
    );
  }

  /**
   * Availability is window containment minus room-wide `CONFIRMED` overlap. The
   * overlap is room-wide rather than window-wide because a confirmed stay keeps
   * occupying its physical room after an admin edit moved it to another window,
   * and because an older stay may still reference a since-deactivated window.
   * List and detail build the exclusion here so they cannot drift apart, and the
   * comparison itself comes from the booking module so reads and writes agree.
   */
  private confirmedOverlapExclusion(
    queryBuilder: SelectQueryBuilder<ObjectLiteral>,
    roomIdExpression: string,
  ): string {
    return `NOT EXISTS ${queryBuilder
      .subQuery()
      .select('1')
      .from(Booking, 'blocking')
      .innerJoin(
        RoomTime,
        'blockingWindow',
        'blockingWindow.id = blocking.room_time_id',
      )
      .where(`blockingWindow.room_id = ${roomIdExpression}`)
      .andWhere(confirmedOverlapCondition('blocking'))
      .getQuery()}`;
  }

  private stayContainmentCondition(alias: string): string {
    return `${alias}.status = :windowStatus AND ${alias}.available_from <= :checkIn AND ${alias}.available_to >= :checkOut`;
  }

  private stayContainmentParameters(stay: StayRange) {
    return {
      windowStatus: RoomTimeStatus.Active,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
    };
  }

  /** List items carry the thumbnail; `SPEC-005` puts the album on detail only. */
  private toPublicRoomResponse(
    room: Room,
    roomType: RoomType,
    amenities: Amenity[],
    images: RoomImageSet | undefined,
    available: boolean | undefined,
  ): PublicRoomResponseDto {
    return {
      id: room.id,
      roomType: this.toPublicRoomTypeResponse(roomType),
      bedCount: room.bedCount,
      viewCode: room.viewCode,
      basePriceAmount: Number(room.basePriceAmount),
      currency: room.currency,
      amenities: amenities.map((amenity) =>
        this.toPublicAmenityResponse(amenity),
      ),
      thumbnail: images?.thumbnail
        ? this.toPublicRoomImageResponse(images.thumbnail)
        : null,
      ...(available === undefined ? {} : { available }),
    };
  }

  private toPublicRoomDetailResponse(
    room: Room,
    roomType: RoomType,
    amenities: Amenity[],
    images: RoomImageSet | undefined,
    available: boolean | undefined,
  ): PublicRoomResponseDto {
    return {
      ...this.toPublicRoomResponse(
        room,
        roomType,
        amenities,
        images,
        available,
      ),
      images: (images?.album ?? []).map((image) =>
        this.toPublicRoomImageResponse(image),
      ),
    };
  }

  /**
   * Explicit narrowing: the public payload carries the short-lived read and its
   * expiry, never the attachment ID, object key, or upload metadata.
   */
  private toPublicRoomImageResponse(image: {
    url: string;
    expiresAt: string;
  }): PublicRoomImageResponseDto {
    return { url: image.url, expiresAt: image.expiresAt };
  }

  private toPublicRoomTypeResponse(
    roomType: RoomType,
  ): PublicRoomTypeResponseDto {
    return {
      id: roomType.id,
      name: roomType.name,
      description: roomType.description,
    };
  }

  private toPublicAmenityResponse(amenity: Amenity): PublicAmenityResponseDto {
    return { id: amenity.id, code: amenity.code, name: amenity.name };
  }

  private readSnapshot<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(work);
  }
}
