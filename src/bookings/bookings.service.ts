import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DataSource,
  EntityManager,
  LessThanOrEqual,
  MoreThanOrEqual,
  SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { RoomTimeStatus, RoomStatus } from '../rooms/entities/room.enums';
import { RoomTime } from '../rooms/entities/room-time.entity';
import { RoomType } from '../rooms/entities/room-type.entity';
import { lockRoom, type LockedRoom } from '../rooms/room-lock';
import { bookingsConfig } from '../config/bookings.config';
import { ApplicationException } from '../common/errors/application.exception';
import {
  BookingActorType,
  BookingStatus,
  IdempotencyKeyStatus,
} from './entities/booking.enums';
import { BookingStatusHistory } from './entities/booking-status-history.entity';
import { Booking } from './entities/booking.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import {
  bookingCreateFingerprint,
  createMonotonicBookingId,
  assertBookingDates,
} from './booking-create.helpers';
import {
  BookingCreateInput,
  BookingCreateResponse,
} from './booking-create.types';
import { UserBookingQueryDto } from './dto/user-booking-query.dto';
import { bookingsErrors } from './bookings.errors';
import {
  PaginatedUserBookingsResponse,
  UserBookingDetailResponse,
  UserBookingResponse,
} from './user-booking.types';

const bookingCreateOperation = 'BOOKING_CREATE';
const bookingCancelOperation = 'BOOKING_CANCEL';
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

interface BookingCreateTransactionResult {
  response: BookingCreateResponse;
  replayed: boolean;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(bookingsConfig.KEY)
    private readonly configuration: ConfigType<typeof bookingsConfig>,
  ) {}

  async create(
    actorUserId: string,
    idempotencyKey: string | undefined,
    input: BookingCreateInput,
    requestId?: string,
  ): Promise<BookingCreateResponse> {
    if (!idempotencyKey || !idempotencyKeyPattern.test(idempotencyKey)) {
      throw bookingsErrors.idempotencyKeyInvalid();
    }
    const fingerprint = bookingCreateFingerprint(actorUserId, input);

    try {
      const result = await this.dataSource.transaction((manager) =>
        this.createInTransaction(
          manager,
          actorUserId,
          idempotencyKey,
          fingerprint,
          input,
        ),
      );
      this.logger.log({
        event: result.replayed ? 'booking_create_replayed' : 'booking_created',
        requestId,
        operation: bookingCreateOperation,
        actorType: BookingActorType.User,
        publicBookingId: result.response.id,
        result: result.replayed ? 'replayed' : 'created',
      });
      return result.response;
    } catch (error) {
      if (
        error instanceof ApplicationException &&
        error.errorCode === 'IDEMPOTENCY_KEY_REUSED'
      ) {
        this.logger.warn({
          event: 'booking_idempotency_conflict',
          requestId,
          operation: bookingCreateOperation,
          actorType: BookingActorType.User,
          result: 'conflict',
          errorCode: error.errorCode,
        });
      }
      throw error;
    }
  }

  async listOwn(
    actorUserId: string,
    query: UserBookingQueryDto,
  ): Promise<PaginatedUserBookingsResponse> {
    assertBookingFilterRange(query);
    const builder = this.ownBookingSummaryQuery(
      this.dataSource.manager,
      actorUserId,
    );
    if (query.status) builder.andWhere('booking.status = :status', query);
    if (query.from && query.to) {
      builder.andWhere(
        'booking.check_in < :to AND booking.check_out > :from',
        query,
      );
    }
    const [bookings, total] = await builder
      .orderBy('booking.createdAt', 'DESC')
      .addOrderBy('booking.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: bookings.map(toUserBookingResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getOwn(
    actorUserId: string,
    bookingPublicId: string,
  ): Promise<UserBookingDetailResponse> {
    return this.getOwnDetail(
      this.dataSource.manager,
      actorUserId,
      bookingPublicId,
    );
  }

  async cancelOwn(
    actorUserId: string,
    bookingPublicId: string,
    requestId?: string,
  ): Promise<UserBookingDetailResponse> {
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const booking = await manager.findOne(Booking, {
          where: { publicId: bookingPublicId, userId: actorUserId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!booking) throw bookingsErrors.notFound();
        if (booking.status === BookingStatus.CancelledByUser) return true;
        if (booking.status !== BookingStatus.Pending) {
          throw bookingsErrors.statusConflict();
        }
        booking.status = BookingStatus.CancelledByUser;
        await manager.save(booking);
        await manager.insert(BookingStatusHistory, {
          bookingId: booking.id,
          fromStatus: BookingStatus.Pending,
          toStatus: BookingStatus.CancelledByUser,
          actorType: BookingActorType.User,
          actorUserId,
          reason: null,
        });
        return false;
      });
      const response = await this.getOwn(actorUserId, bookingPublicId);
      this.logger.log({
        event: result ? 'booking_cancel_replayed' : 'booking_cancelled_by_user',
        requestId,
        operation: bookingCancelOperation,
        actorType: BookingActorType.User,
        publicBookingId: response.id,
        result: result ? 'replayed' : 'cancelled',
      });
      return response;
    } catch (error) {
      if (
        error instanceof ApplicationException &&
        error.errorCode === 'BOOKING_STATUS_CONFLICT'
      ) {
        this.logger.warn({
          event: 'booking_cancel_conflict',
          requestId,
          operation: bookingCancelOperation,
          actorType: BookingActorType.User,
          result: 'conflict',
          errorCode: error.errorCode,
        });
      }
      throw error;
    }
  }

  private ownBookingSummaryQuery(
    manager: EntityManager,
    actorUserId: string,
  ): SelectQueryBuilder<Booking> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .innerJoinAndSelect('booking.roomTime', 'roomTime')
      .innerJoinAndSelect('roomTime.room', 'room')
      .innerJoinAndSelect('room.roomType', 'roomType')
      .where('booking.user_id = :actorUserId', { actorUserId })
      .select([
        'booking.id',
        'booking.publicId',
        'booking.userId',
        'booking.roomTimeId',
        'booking.checkIn',
        'booking.checkOut',
        'booking.status',
        'booking.priceAmount',
        'booking.currency',
        'booking.rejectionReason',
        'booking.version',
        'booking.createdAt',
        'booking.updatedAt',
        'roomTime.id',
        'roomTime.roomId',
        'room.id',
        'room.roomTypeId',
        'room.roomNumber',
        'roomType.id',
        'roomType.name',
      ]);
  }

  private async getOwnDetail(
    manager: EntityManager,
    actorUserId: string,
    bookingPublicId: string,
  ): Promise<UserBookingDetailResponse> {
    const booking = await this.ownBookingSummaryQuery(manager, actorUserId)
      .andWhere('booking.public_id = :bookingPublicId', { bookingPublicId })
      .getOne();
    if (!booking) throw bookingsErrors.notFound();
    const history = await manager
      .getRepository(BookingStatusHistory)
      .createQueryBuilder('history')
      .leftJoinAndSelect('history.actorUser', 'actor')
      .where('history.booking_id = :bookingId', { bookingId: booking.id })
      .select([
        'history.id',
        'history.fromStatus',
        'history.toStatus',
        'history.actorType',
        'history.reason',
        'history.createdAt',
        'actor.id',
        'actor.displayName',
      ])
      .orderBy('history.createdAt', 'ASC')
      .addOrderBy('history.id', 'ASC')
      .getMany();
    return {
      ...toUserBookingResponse(booking),
      history: history.map(toHistoryResponse),
    };
  }

  private async createInTransaction(
    manager: EntityManager,
    actorUserId: string,
    idempotencyKey: string,
    fingerprint: string,
    input: BookingCreateInput,
  ): Promise<BookingCreateTransactionResult> {
    const idempotency = await this.lockIdempotency(
      manager,
      actorUserId,
      idempotencyKey,
      fingerprint,
    );
    if (idempotency.status === IdempotencyKeyStatus.Completed) {
      return {
        response: idempotency.responseBody as unknown as BookingCreateResponse,
        replayed: true,
      };
    }

    // A completed retry must replay even when its check-in has since become past.
    // Date policy only determines whether a previously unseen request can create.
    const nights = assertBookingDates(input, this.configuration.hotelTimezone);
    if (!nights) throw bookingsErrors.stayInvalid();

    const { room, roomTime } = await this.lockBookingTarget(manager, input);
    const priceAmount = BigInt(room.basePriceAmount) * BigInt(nights);
    if (priceAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw bookingsErrors.priceOutOfRange();
    }

    const booking = await this.createPendingBooking(
      manager,
      actorUserId,
      roomTime,
      input,
      priceAmount,
      room.currency,
    );
    const roomType = await this.findResponseRoomType(manager, room.roomTypeId);
    const response = toCreateResponse(booking, room, roomType, nights);
    await this.completeIdempotency(manager, idempotency.id, response);
    return { response, replayed: false };
  }

  private async lockBookingTarget(
    manager: EntityManager,
    input: BookingCreateInput,
  ): Promise<{ room: LockedRoom; roomTime: RoomTime }> {
    // Only booking-create retries claim idempotency rows, so no room mutation takes
    // an idempotency lock after it holds a room. Every shared room mutation then
    // takes the durable order: physical room before room-time. Booking create
    // touches one room only, so it cannot invert the order used by room-time
    // administration or later multi-room booking changes.
    const room = await lockRoom(manager, input.roomId);
    if (room.status !== RoomStatus.Active) throw bookingsErrors.roomNotFound();

    const roomTime = await manager.findOne(RoomTime, {
      where: {
        roomId: room.id,
        status: RoomTimeStatus.Active,
        availableFrom: LessThanOrEqual(input.checkIn),
        availableTo: MoreThanOrEqual(input.checkOut),
      },
      lock: { mode: 'pessimistic_write' },
      order: { availableFrom: 'ASC', id: 'ASC' },
    });
    if (!roomTime) throw bookingsErrors.windowUnavailable();
    return { room, roomTime };
  }

  private async createPendingBooking(
    manager: EntityManager,
    actorUserId: string,
    roomTime: RoomTime,
    input: BookingCreateInput,
    priceAmount: bigint,
    currency: string,
  ): Promise<Booking> {
    const booking = await manager.save(
      manager.create(Booking, {
        publicId: createMonotonicBookingId(),
        userId: actorUserId,
        roomTimeId: roomTime.id,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        status: BookingStatus.Pending,
        priceAmount: priceAmount.toString(),
        currency,
        rejectionReason: null,
      }),
    );
    await manager.insert(BookingStatusHistory, {
      bookingId: booking.id,
      fromStatus: null,
      toStatus: BookingStatus.Pending,
      actorType: BookingActorType.User,
      actorUserId,
      reason: null,
    });
    return booking;
  }

  private async findResponseRoomType(
    manager: EntityManager,
    roomTypeId: string,
  ): Promise<RoomType> {
    return manager.findOneOrFail(RoomType, {
      where: { id: roomTypeId },
      select: { id: true, name: true },
    });
  }

  private async completeIdempotency(
    manager: EntityManager,
    idempotencyId: string,
    response: BookingCreateResponse,
  ): Promise<void> {
    await manager.update(IdempotencyKey, idempotencyId, {
      status: IdempotencyKeyStatus.Completed,
      responseStatus: 201,
      responseBody: response as unknown as QueryDeepPartialEntity<
        Record<string, unknown>
      >,
    });
  }

  private async lockIdempotency(
    manager: EntityManager,
    actorUserId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<IdempotencyKey> {
    await manager.query(
      `INSERT INTO idempotency_keys
        (actor_user_id, operation, idempotency_key, request_fingerprint, status, response_status, response_body, expires_at)
       VALUES (?, ?, ?, ?, 'PENDING', NULL, NULL, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [
        actorUserId,
        bookingCreateOperation,
        idempotencyKey,
        fingerprint,
        new Date(
          Date.now() + this.configuration.idempotencyRetentionHours * 3_600_000,
        ),
      ],
    );
    const row = await manager.findOneOrFail(IdempotencyKey, {
      where: {
        actorUserId,
        operation: bookingCreateOperation,
        idempotencyKey,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (row.requestFingerprint !== fingerprint) {
      throw bookingsErrors.idempotencyKeyReused();
    }
    return row;
  }
}

function toCreateResponse(
  booking: Booking,
  room: Awaited<ReturnType<typeof lockRoom>>,
  roomType: RoomType,
  nights: number,
): BookingCreateResponse {
  return {
    id: booking.publicId,
    room: {
      id: room.id,
      roomNumber: room.roomNumber,
      roomType: { id: roomType.id, name: roomType.name },
    },
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights,
    status: 'PENDING',
    price: { amount: Number(booking.priceAmount), currency: booking.currency },
    rejectionReason: null,
    version: Number(booking.version),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

function toUserBookingResponse(booking: Booking): UserBookingResponse {
  const room = booking.roomTime.room;
  return {
    id: booking.publicId,
    room: {
      id: room.id,
      roomNumber: room.roomNumber,
      roomType: { id: room.roomType.id, name: room.roomType.name },
    },
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: Math.round(
      (Date.parse(`${booking.checkOut}T00:00:00Z`) -
        Date.parse(`${booking.checkIn}T00:00:00Z`)) /
        86_400_000,
    ),
    status: booking.status,
    price: { amount: Number(booking.priceAmount), currency: booking.currency },
    rejectionReason: booking.rejectionReason,
    version: Number(booking.version),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
  };
}

function toHistoryResponse(history: BookingStatusHistory) {
  return {
    fromStatus: history.fromStatus,
    toStatus: history.toStatus,
    actorType: history.actorType,
    ...(history.actorUser
      ? {
          actor: {
            id: history.actorUser.id,
            displayName: history.actorUser.displayName,
          },
        }
      : {}),
    reason: history.reason,
    createdAt: history.createdAt.toISOString(),
  };
}

function assertBookingFilterRange(query: UserBookingQueryDto): void {
  if ((query.from === undefined) !== (query.to === undefined)) {
    throw bookingsErrors.stayInvalid();
  }
  if (query.from && query.to && query.from >= query.to) {
    throw bookingsErrors.stayInvalid();
  }
}
