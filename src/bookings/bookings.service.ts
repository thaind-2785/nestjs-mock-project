import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DataSource,
  EntityManager,
  LessThanOrEqual,
  MoreThanOrEqual,
} from 'typeorm';
import { RoomTimeStatus, RoomStatus } from '../rooms/entities/room.enums';
import { RoomTime } from '../rooms/entities/room-time.entity';
import { RoomType } from '../rooms/entities/room-type.entity';
import { lockRoom } from '../rooms/room-lock';
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
import { bookingsErrors } from './bookings.errors';

const bookingCreateOperation = 'BOOKING_CREATE';
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

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
      const result = await this.dataSource.transaction(async (manager) => {
        const idempotency = await this.lockIdempotency(
          manager,
          actorUserId,
          idempotencyKey,
          fingerprint,
        );
        if (idempotency.status === IdempotencyKeyStatus.Completed) {
          return {
            response:
              idempotency.responseBody as unknown as BookingCreateResponse,
            replayed: true,
          };
        }
        // A completed retry must replay even when its check-in has since become past.
        // Date policy only determines whether a previously unseen request can create.
        const nights = assertBookingDates(
          input,
          this.configuration.hotelTimezone,
        );
        if (!nights) throw bookingsErrors.stayInvalid();

        const room = await lockRoom(manager, input.roomId);
        if (room.status !== RoomStatus.Active)
          throw bookingsErrors.roomNotFound();
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
        if (!roomTime) {
          throw bookingsErrors.windowUnavailable();
        }

        const priceAmount = BigInt(room.basePriceAmount) * BigInt(nights);
        if (priceAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw bookingsErrors.priceOutOfRange();
        }
        const booking = await manager.save(
          manager.create(Booking, {
            publicId: createMonotonicBookingId(),
            userId: actorUserId,
            roomTimeId: roomTime.id,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            status: BookingStatus.Pending,
            priceAmount: priceAmount.toString(),
            currency: room.currency,
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
        const roomType = await manager.findOneByOrFail(RoomType, {
          id: room.roomTypeId,
        });
        const response = toCreateResponse(booking, room, roomType, nights);
        idempotency.status = IdempotencyKeyStatus.Completed;
        idempotency.responseStatus = 201;
        idempotency.responseBody = response as unknown as Record<
          string,
          unknown
        >;
        await manager.save(idempotency);
        return { response, replayed: false };
      });
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
