import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { emptyRoomTimeUsage, RoomTimeUsage } from '../rooms/room-time-policy';
import type { RoomTimeUsageRepository } from '../rooms/room-time-usage.repository';
import { BookingChangeHistory } from './entities/booking-change-history.entity';
import { Booking } from './entities/booking.entity';
import { BookingStatus } from './entities/booking.enums';

/** Only these statuses still claim their window; terminal bookings are history. */
const activeBookingStatuses = [BookingStatus.Pending, BookingStatus.Confirmed];

interface CountRow {
  roomTimeId: string;
  total: string | number;
  active?: string | number;
}

/**
 * The real usage port behind room-time administration.
 *
 * Every caller that can act on usage already holds the physical room lock, and so
 * does every booking write that can *raise* a count: creation, and the
 * destination side of an admin edit. Those therefore cannot move under a caller
 * inside its transaction.
 *
 * Three transitions take no room lock — user cancellation, admin rejection, and
 * admin cancellation — because none of them needs to serialize against room
 * inventory. Each moves a booking from `PENDING` or `CONFIRMED` to a terminal
 * status, so each can only *lower* `activeBookingCount` and can change nothing
 * else. A count read concurrently with one of them is therefore at worst too
 * high, which refuses a window mutation that would have been allowed a moment
 * later. That is the safe direction for this port, whose absent-entry contract
 * already treats unknown usage as blocking rather than as zero.
 */
@Injectable()
export class BookingRoomTimeUsageRepository implements RoomTimeUsageRepository {
  public async findByRoomTimeIds(
    manager: EntityManager,
    roomTimeIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomTimeUsage>> {
    // Seeded with zeros so an unused window is reported as unused, while a
    // window nobody asked about stays absent and keeps failing the contract.
    const usage = new Map<string, RoomTimeUsage>(
      roomTimeIds.map((roomTimeId) => [roomTimeId, { ...emptyRoomTimeUsage }]),
    );
    const ids = [...usage.keys()];
    if (!ids.length) return usage;

    // Sequential on purpose: the caller's manager is a transactional one bound
    // to a single connection, so issuing these together would only queue them
    // behind each other while making the failure modes harder to reason about.
    const bookingRows = await this.countBookings(manager, ids);
    const fromRows = await this.countChanges(manager, ids, 'from_room_time_id');
    const toRows = await this.countChanges(manager, ids, 'to_room_time_id');

    for (const row of bookingRows) {
      const entry = usage.get(row.roomTimeId);
      if (!entry) continue;
      entry.bookingCount = Number(row.total);
      entry.activeBookingCount = Number(row.active ?? 0);
    }
    for (const row of [...fromRows, ...toRows]) {
      const entry = usage.get(row.roomTimeId);
      if (!entry) continue;
      entry.changeHistoryCount += Number(row.total);
    }
    return usage;
  }

  private countBookings(
    manager: EntityManager,
    ids: string[],
  ): Promise<CountRow[]> {
    return manager
      .getRepository(Booking)
      .createQueryBuilder('booking')
      .select('booking.room_time_id', 'roomTimeId')
      .addSelect('COUNT(*)', 'total')
      .addSelect(
        'SUM(CASE WHEN booking.status IN (:...activeStatuses) THEN 1 ELSE 0 END)',
        'active',
      )
      .where('booking.room_time_id IN (:...ids)', { ids })
      .setParameter('activeStatuses', activeBookingStatuses)
      .groupBy('booking.room_time_id')
      .getRawMany<CountRow>();
  }

  /**
   * A change row references one window through each column, and a date-only edit
   * keeps the same window in both, so the destination side skips the rows whose
   * source window is identical. Counting both columns unconditionally would
   * report one such edit as two changes.
   */
  private countChanges(
    manager: EntityManager,
    ids: string[],
    column: 'from_room_time_id' | 'to_room_time_id',
  ): Promise<CountRow[]> {
    const builder = manager
      .getRepository(BookingChangeHistory)
      .createQueryBuilder('change')
      .select(`change.${column}`, 'roomTimeId')
      .addSelect('COUNT(*)', 'total')
      .where(`change.${column} IN (:...ids)`, { ids })
      .groupBy(`change.${column}`);
    if (column === 'to_room_time_id') {
      builder.andWhere('change.to_room_time_id <> change.from_room_time_id');
    }
    return builder.getRawMany<CountRow>();
  }
}
