import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  OutboxEventStatus,
} from './entities/booking.enums';
import { BookingStatusHistory } from './entities/booking-status-history.entity';
import { BookingChangeHistory } from './entities/booking-change-history.entity';
import { Booking } from './entities/booking.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
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
import { AdminBookingQueryDto } from './dto/admin-booking-query.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { bookingsErrors } from './bookings.errors';
import { orderedUniqueRoomIds } from './booking-lock-order';
import {
  PaginatedUserBookingsResponse,
  UserBookingDetailResponse,
  UserBookingResponse,
} from './user-booking.types';
import {
  AdminBookingDetailResponse,
  AdminBookingResponse,
  AdminTransitionInput,
  PaginatedAdminBookingsResponse,
} from './admin-booking.types';

const bookingCreateOperation = 'BOOKING_CREATE';
const bookingCancelOperation = 'BOOKING_CANCEL';
const bookingApproveOperation = 'BOOKING_APPROVE';
const bookingRejectOperation = 'BOOKING_REJECT';
const bookingUpdateOperation = 'BOOKING_UPDATE';
const bookingAdminCancelOperation = 'BOOKING_ADMIN_CANCEL';
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

type BookingOutboxEventType =
  | 'booking.confirmed'
  | 'booking.rejected'
  | 'booking.changed'
  | 'booking.cancelled_by_admin';

interface BookingChangeOutboxEndpoint {
  roomId: string;
  checkIn: string;
  checkOut: string;
}

interface BookingChangeOutboxDetail {
  before: BookingChangeOutboxEndpoint;
  after: BookingChangeOutboxEndpoint;
}

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

  async listAdmin(
    query: AdminBookingQueryDto,
  ): Promise<PaginatedAdminBookingsResponse> {
    assertBookingFilterRange(query);
    const builder = this.adminBookingSummaryQuery(this.dataSource.manager);
    if (query.status) builder.andWhere('booking.status = :status', query);
    if (query.from && query.to) {
      builder.andWhere(
        'booking.check_in < :to AND booking.check_out > :from',
        query,
      );
    }
    if (query.roomId) builder.andWhere('room.id = :roomId', query);
    if (query.roomTypeId) builder.andWhere('roomType.id = :roomTypeId', query);
    if (query.userId) builder.andWhere('owner.id = :userId', query);
    const [bookings, total] = await builder
      .orderBy('booking.createdAt', 'DESC')
      .addOrderBy('booking.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    return {
      items: bookings.map(toAdminBookingResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getAdmin(bookingPublicId: string): Promise<AdminBookingDetailResponse> {
    const booking = await this.adminBookingSummaryQuery(this.dataSource.manager)
      .andWhere('booking.public_id = :bookingPublicId', { bookingPublicId })
      .getOne();
    if (!booking) throw bookingsErrors.notFound();
    const [history, changes] = await Promise.all([
      this.statusHistory(this.dataSource.manager, booking.id),
      this.changeHistory(this.dataSource.manager, booking.id),
    ]);
    return {
      ...toAdminBookingResponse(booking),
      history: history.map(toHistoryResponse),
      changes,
    };
  }

  async approve(
    input: AdminTransitionInput,
  ): Promise<AdminBookingDetailResponse> {
    const snapshot = await this.dataSource.manager.findOne(Booking, {
      where: { publicId: input.bookingPublicId },
      relations: { roomTime: true },
      select: {
        id: true,
        roomTimeId: true,
        version: true,
        roomTime: { id: true, roomId: true },
      },
    });
    if (!snapshot) throw bookingsErrors.notFound();

    const replayed = await this.dataSource
      .transaction(async (manager) => {
        const room = await lockRoom(manager, snapshot.roomTime.roomId);
        const booking = await manager.findOne(Booking, {
          where: { publicId: input.bookingPublicId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!booking) throw bookingsErrors.notFound();
        // An already confirmed row is the only idempotent approval replay. Check it
        // after taking the row lock but before comparing the pre-read snapshot: a
        // competing approval legitimately increments version before this request wakes.
        if (booking.status === BookingStatus.Confirmed) return true;
        if (
          booking.roomTimeId !== snapshot.roomTimeId ||
          booking.version !== snapshot.version
        ) {
          throw bookingsErrors.stateChanged();
        }
        if (booking.status !== BookingStatus.Pending)
          throw bookingsErrors.statusConflict();
        const roomTime = await manager.findOne(RoomTime, {
          where: { id: booking.roomTimeId, roomId: room.id },
          select: {
            id: true,
            roomId: true,
            availableFrom: true,
            availableTo: true,
            status: true,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !roomTime ||
          roomTime.status !== RoomTimeStatus.Active ||
          roomTime.availableFrom > booking.checkIn ||
          roomTime.availableTo < booking.checkOut
        ) {
          throw bookingsErrors.windowUnavailable();
        }
        await this.assertNoConfirmedOverlap(
          manager,
          room.id,
          booking.id,
          booking.checkIn,
          booking.checkOut,
        );
        booking.status = BookingStatus.Confirmed;
        const saved = await manager.save(booking);
        await this.appendTransitionAndOutbox(
          manager,
          saved,
          input.actorUserId,
          null,
          'booking.confirmed',
          room,
        );
        return false;
      })
      .catch((error: unknown) => {
        this.logAdminFailure(input, bookingApproveOperation, error);
        throw error;
      });
    const response = await this.getAdmin(input.bookingPublicId);
    this.logAdminTransition(
      replayed ? 'booking_approve_replayed' : 'booking_approved',
      input,
      response.id,
      bookingApproveOperation,
      replayed ? 'replayed' : 'approved',
    );
    return response;
  }

  async reject(
    input: Required<
      Pick<AdminTransitionInput, 'actorUserId' | 'bookingPublicId' | 'reason'>
    > &
      Pick<AdminTransitionInput, 'requestId'>,
  ): Promise<AdminBookingDetailResponse> {
    const replayed = await this.dataSource
      .transaction(async (manager) => {
        const booking = await manager.findOne(Booking, {
          where: { publicId: input.bookingPublicId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!booking) throw bookingsErrors.notFound();
        if (booking.status === BookingStatus.Rejected) {
          if (booking.rejectionReason === input.reason) return true;
          throw bookingsErrors.statusConflict();
        }
        if (booking.status !== BookingStatus.Pending)
          throw bookingsErrors.statusConflict();
        booking.status = BookingStatus.Rejected;
        booking.rejectionReason = input.reason;
        const saved = await manager.save(booking);
        const roomTime = await manager.findOneOrFail(RoomTime, {
          where: { id: booking.roomTimeId },
          relations: { room: true },
          select: {
            id: true,
            roomId: true,
            room: { id: true, roomNumber: true },
          },
        });
        await this.appendTransitionAndOutbox(
          manager,
          saved,
          input.actorUserId,
          input.reason,
          'booking.rejected',
          roomTime.room,
        );
        return false;
      })
      .catch((error: unknown) => {
        this.logAdminFailure(input, bookingRejectOperation, error);
        throw error;
      });
    const response = await this.getAdmin(input.bookingPublicId);
    this.logAdminTransition(
      replayed ? 'booking_reject_replayed' : 'booking_rejected',
      input,
      response.id,
      bookingRejectOperation,
      replayed ? 'replayed' : 'rejected',
    );
    return response;
  }

  async updateAdmin(input: {
    actorUserId: string;
    bookingPublicId: string;
    expectedVersion: string;
    body: UpdateBookingDto;
    requestId?: string;
  }): Promise<AdminBookingDetailResponse> {
    const snapshot = await this.bookingSourceSnapshot(input.bookingPublicId);
    if (snapshot.version !== input.expectedVersion)
      throw bookingsErrors.versionConflict();
    const destinationRoomId = input.body.roomId ?? snapshot.roomTime.roomId;
    await this.dataSource
      .transaction(async (manager) => {
        const roomIds = orderedUniqueRoomIds([
          snapshot.roomTime.roomId,
          destinationRoomId,
        ]);
        const rooms = new Map<string, LockedRoom>();
        for (const roomId of roomIds)
          rooms.set(roomId, await lockRoom(manager, roomId));
        const booking = await manager.findOne(Booking, {
          where: { publicId: input.bookingPublicId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!booking) throw bookingsErrors.notFound();
        if (booking.version !== input.expectedVersion)
          throw bookingsErrors.versionConflict();
        if (booking.roomTimeId !== snapshot.roomTimeId)
          throw bookingsErrors.stateChanged();
        const sourceWindow = await manager.findOne(RoomTime, {
          where: {
            id: booking.roomTimeId,
            roomId: snapshot.roomTime.roomId,
          },
          select: {
            id: true,
            roomId: true,
            availableFrom: true,
            availableTo: true,
            status: true,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!sourceWindow) throw bookingsErrors.stateChanged();
        if (
          ![BookingStatus.Pending, BookingStatus.Confirmed].includes(
            booking.status,
          )
        ) {
          throw bookingsErrors.statusConflict();
        }
        const checkIn = input.body.checkIn ?? booking.checkIn;
        const checkOut = input.body.checkOut ?? booking.checkOut;
        if (
          destinationRoomId === snapshot.roomTime.roomId &&
          checkIn === booking.checkIn &&
          checkOut === booking.checkOut
        )
          throw bookingsErrors.changeEmpty();
        if (
          !assertBookingDates(
            { checkIn, checkOut },
            this.configuration.hotelTimezone,
          )
        ) {
          throw bookingsErrors.stayInvalid();
        }
        const destinationRoom = rooms.get(destinationRoomId);
        if (!destinationRoom || destinationRoom.status !== RoomStatus.Active)
          throw bookingsErrors.roomNotFound();
        const destinationWindow = await manager.findOne(RoomTime, {
          where: {
            roomId: destinationRoomId,
            status: RoomTimeStatus.Active,
            availableFrom: LessThanOrEqual(checkIn),
            availableTo: MoreThanOrEqual(checkOut),
          },
          select: {
            id: true,
            roomId: true,
            availableFrom: true,
            availableTo: true,
            status: true,
          },
          lock: { mode: 'pessimistic_write' },
          order: { availableFrom: 'ASC', id: 'ASC' },
        });
        if (!destinationWindow) throw bookingsErrors.windowUnavailable();
        if (booking.status === BookingStatus.Confirmed) {
          await this.assertNoConfirmedOverlap(
            manager,
            destinationRoomId,
            booking.id,
            checkIn,
            checkOut,
          );
        }
        const before = {
          roomTimeId: booking.roomTimeId,
          roomId: snapshot.roomTime.roomId,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        };
        booking.roomTimeId = destinationWindow.id;
        booking.checkIn = checkIn;
        booking.checkOut = checkOut;
        const saved = await manager.save(booking);
        await manager.insert(BookingChangeHistory, {
          bookingId: saved.id,
          actorUserId: input.actorUserId,
          fromRoomTimeId: before.roomTimeId,
          toRoomTimeId: destinationWindow.id,
          fromCheckIn: before.checkIn,
          fromCheckOut: before.checkOut,
          toCheckIn: checkIn,
          toCheckOut: checkOut,
          reason: input.body.reason,
        });
        await this.insertOutbox(
          manager,
          saved,
          'booking.changed',
          destinationRoom,
          {
            reason: input.body.reason,
            change: {
              before: {
                roomId: before.roomId,
                checkIn: before.checkIn,
                checkOut: before.checkOut,
              },
              after: { roomId: destinationRoomId, checkIn, checkOut },
            },
          },
        );
      })
      .catch((error: unknown) => {
        this.logAdminFailure(input, bookingUpdateOperation, error);
        throw error;
      });
    const response = await this.getAdmin(input.bookingPublicId);
    this.logAdminTransition(
      'booking_updated',
      input,
      response.id,
      bookingUpdateOperation,
      'updated',
    );
    return response;
  }

  async cancelAdmin(
    input: Required<
      Pick<AdminTransitionInput, 'actorUserId' | 'bookingPublicId' | 'reason'>
    > &
      Pick<AdminTransitionInput, 'requestId'>,
  ): Promise<AdminBookingDetailResponse> {
    const replayed = await this.dataSource
      .transaction(async (manager) => {
        const booking = await manager.findOne(Booking, {
          where: { publicId: input.bookingPublicId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!booking) throw bookingsErrors.notFound();
        if (booking.status === BookingStatus.CancelledByAdmin) {
          const latest = await manager.findOne(BookingStatusHistory, {
            where: {
              bookingId: booking.id,
              toStatus: BookingStatus.CancelledByAdmin,
            },
            select: { id: true, reason: true },
            order: { createdAt: 'DESC', id: 'DESC' },
          });
          if (latest?.reason === input.reason) return true;
          throw bookingsErrors.statusConflict();
        }
        if (
          ![BookingStatus.Pending, BookingStatus.Confirmed].includes(
            booking.status,
          )
        )
          throw bookingsErrors.statusConflict();
        const fromStatus = booking.status;
        booking.status = BookingStatus.CancelledByAdmin;
        const saved = await manager.save(booking);
        const roomTime = await manager.findOneOrFail(RoomTime, {
          where: { id: booking.roomTimeId },
          relations: { room: true },
          select: {
            id: true,
            roomId: true,
            room: { id: true, roomNumber: true },
          },
        });
        await manager.insert(BookingStatusHistory, {
          bookingId: booking.id,
          fromStatus,
          toStatus: BookingStatus.CancelledByAdmin,
          actorType: BookingActorType.Admin,
          actorUserId: input.actorUserId,
          reason: input.reason,
        });
        await this.insertOutbox(
          manager,
          saved,
          'booking.cancelled_by_admin',
          roomTime.room,
          { reason: input.reason },
        );
        return false;
      })
      .catch((error: unknown) => {
        this.logAdminFailure(input, bookingAdminCancelOperation, error);
        throw error;
      });
    const response = await this.getAdmin(input.bookingPublicId);
    this.logAdminTransition(
      replayed ? 'booking_admin_cancel_replayed' : 'booking_cancelled_by_admin',
      input,
      response.id,
      bookingAdminCancelOperation,
      replayed ? 'replayed' : 'cancelled',
    );
    return response;
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

  private adminBookingSummaryQuery(
    manager: EntityManager,
  ): SelectQueryBuilder<Booking> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .innerJoinAndSelect('booking.roomTime', 'roomTime')
      .innerJoinAndSelect('roomTime.room', 'room')
      .innerJoinAndSelect('room.roomType', 'roomType')
      .innerJoinAndSelect('booking.user', 'owner')
      .select([
        'booking.id',
        'booking.publicId',
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
        'owner.id',
        'owner.email',
        'owner.displayName',
        'owner.status',
      ]);
  }

  private statusHistory(
    manager: EntityManager,
    bookingId: string,
  ): Promise<BookingStatusHistory[]> {
    return manager
      .getRepository(BookingStatusHistory)
      .createQueryBuilder('history')
      .leftJoinAndSelect('history.actorUser', 'actor')
      .where('history.booking_id = :bookingId', { bookingId })
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
  }

  private async changeHistory(
    manager: EntityManager,
    bookingId: string,
  ): Promise<AdminBookingDetailResponse['changes']> {
    const changes = await manager
      .getRepository(BookingChangeHistory)
      .createQueryBuilder('change')
      .innerJoinAndSelect('change.actorUser', 'actor')
      .innerJoinAndSelect('change.fromRoomTime', 'fromRoomTime')
      .innerJoinAndSelect('fromRoomTime.room', 'fromRoom')
      .innerJoinAndSelect('change.toRoomTime', 'toRoomTime')
      .innerJoinAndSelect('toRoomTime.room', 'toRoom')
      .where('change.booking_id = :bookingId', { bookingId })
      .select([
        'change.id',
        'change.fromCheckIn',
        'change.fromCheckOut',
        'change.toCheckIn',
        'change.toCheckOut',
        'change.reason',
        'change.createdAt',
        'actor.id',
        'actor.displayName',
        'fromRoomTime.id',
        'fromRoomTime.roomId',
        'fromRoom.id',
        'toRoomTime.id',
        'toRoomTime.roomId',
        'toRoom.id',
      ])
      .orderBy('change.createdAt', 'ASC')
      .addOrderBy('change.id', 'ASC')
      .getMany();
    return changes.map((change) => ({
      actor: {
        id: change.actorUser.id,
        displayName: change.actorUser.displayName,
      },
      from: {
        roomId: change.fromRoomTime.room.id,
        checkIn: change.fromCheckIn,
        checkOut: change.fromCheckOut,
      },
      to: {
        roomId: change.toRoomTime.room.id,
        checkIn: change.toCheckIn,
        checkOut: change.toCheckOut,
      },
      reason: change.reason,
      createdAt: change.createdAt.toISOString(),
    }));
  }

  private async bookingSourceSnapshot(
    bookingPublicId: string,
  ): Promise<Booking> {
    const booking = await this.dataSource.manager.findOne(Booking, {
      where: { publicId: bookingPublicId },
      relations: { roomTime: true },
      select: {
        id: true,
        roomTimeId: true,
        version: true,
        roomTime: { id: true, roomId: true },
      },
    });
    if (!booking) throw bookingsErrors.notFound();
    return booking;
  }

  private async assertNoConfirmedOverlap(
    manager: EntityManager,
    roomId: string,
    bookingId: string,
    checkIn: string,
    checkOut: string,
  ): Promise<void> {
    const conflict = await manager
      .getRepository(Booking)
      .createQueryBuilder('confirmed')
      // Only existence decides this check, so the locking probe projects the key
      // alone instead of hydrating a whole competing booking. The FROM/JOIN shape
      // is unchanged, so both tables still take the same row locks.
      .select('confirmed.id')
      .innerJoin('confirmed.roomTime', 'confirmedRoomTime')
      .where('confirmedRoomTime.room_id = :roomId', { roomId })
      .andWhere('confirmed.status = :confirmedStatus', {
        confirmedStatus: BookingStatus.Confirmed,
      })
      .andWhere('confirmed.id != :bookingId', { bookingId })
      .andWhere(
        'confirmed.check_in < :checkOut AND confirmed.check_out > :checkIn',
        {
          checkIn,
          checkOut,
        },
      )
      .setLock('pessimistic_write')
      .getOne();
    if (conflict) throw bookingsErrors.roomAlreadyBooked();
  }

  /**
   * Every Phase 4 booking event is written here so the accepted payload envelope,
   * the authorized reason position inside the booking snapshot, and the logical
   * `<eventType>:<publicId>:<resultingVersion>` key cannot drift per transition.
   */
  private async insertOutbox(
    manager: EntityManager,
    booking: Booking,
    eventType: BookingOutboxEventType,
    room: Pick<LockedRoom, 'id' | 'roomNumber'>,
    detail: { reason?: string | null; change?: BookingChangeOutboxDetail } = {},
  ): Promise<void> {
    await manager.insert(OutboxEvent, {
      id: randomUUID(),
      eventType,
      payload: {
        schemaVersion: 1,
        bookingId: booking.publicId,
        ownerUserId: booking.userId,
        bookingVersion: Number(booking.version),
        booking: {
          room: { id: room.id, roomNumber: room.roomNumber },
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          status: booking.status,
          price: {
            amount: Number(booking.priceAmount),
            currency: booking.currency,
          },
          ...(detail.reason == null ? {} : { reason: detail.reason }),
        },
        ...detail.change,
      },
      availableAt: new Date(),
      status: OutboxEventStatus.Pending,
      idempotencyKey: `${eventType}:${booking.publicId}:${booking.version}`,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      processedAt: null,
      attempts: 0,
    });
  }

  private async appendTransitionAndOutbox(
    manager: EntityManager,
    booking: Booking,
    actorUserId: string,
    reason: string | null,
    eventType: 'booking.confirmed' | 'booking.rejected',
    room: Pick<LockedRoom, 'id' | 'roomNumber'>,
  ): Promise<void> {
    await manager.insert(BookingStatusHistory, {
      bookingId: booking.id,
      fromStatus: BookingStatus.Pending,
      toStatus: booking.status,
      actorType: BookingActorType.Admin,
      actorUserId,
      reason,
    });
    await this.insertOutbox(manager, booking, eventType, room, { reason });
  }

  private logAdminTransition(
    event: string,
    input: AdminTransitionInput,
    publicBookingId: string,
    operation: string,
    result: string,
  ): void {
    this.logger.log({
      event,
      requestId: input.requestId,
      operation,
      actorType: BookingActorType.Admin,
      publicBookingId,
      result,
    });
  }

  private logAdminFailure(
    input: AdminTransitionInput,
    operation: string,
    error: unknown,
  ): void {
    const applicationError =
      error instanceof ApplicationException ? error : null;
    this.logger.warn({
      event: applicationError
        ? 'booking_transition_conflict'
        : 'booking_outbox_write_failed',
      requestId: input.requestId,
      operation,
      actorType: BookingActorType.Admin,
      publicBookingId: input.bookingPublicId,
      result: applicationError ? 'conflict' : 'failed',
      ...(applicationError ? { errorCode: applicationError.errorCode } : {}),
    });
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

function toAdminBookingResponse(booking: Booking): AdminBookingResponse {
  return {
    ...toUserBookingResponse(booking),
    owner: {
      id: booking.user.id,
      email: booking.user.email,
      displayName: booking.user.displayName,
      status: booking.user.status,
    },
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
