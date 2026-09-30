import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { bookingStatsUpsertChunkSize } from './booking-stats.constants';
import type { BookingStatsFactRow } from './booking-stats.types';

const columns = [
  'booking_public_id',
  'booking_version',
  'status',
  'room_id',
  'room_type_id',
  'check_in',
  'check_out',
  'price_amount',
  'currency',
  'last_event_id',
  'last_occurred_at',
] as const;

/** Every column a newer version replaces; the key and the version itself excluded. */
const replacedColumns = columns.filter(
  (column) => column !== 'booking_public_id' && column !== 'booking_version',
);

const rowPlaceholder = `(${columns.map(() => '?').join(', ')})`;

/**
 * The version guard, in SQL.
 *
 * A column takes the incoming value only when the incoming version is newer than the
 * stored one, and `booking_version` is assigned last: MySQL evaluates the assignments
 * left to right against the row as already updated, so every comparison above it still
 * sees the stored version. That ordering is what makes a duplicate or an older event a
 * no-op without a processed-event table - the same statement is safe to run twice.
 */
const guardedAssignments = [
  ...replacedColumns.map(
    (column) =>
      `${column} = IF(incoming.booking_version > booking_stats_facts.booking_version, incoming.${column}, booking_stats_facts.${column})`,
  ),
  'booking_version = GREATEST(booking_stats_facts.booking_version, incoming.booking_version)',
].join(',\n         ');

/**
 * The read model's only writer.
 *
 * The manager is the caller's, because the caller commits Kafka offsets only after this
 * transaction commits; a default manager would commit each chunk on its own and let an
 * offset commit describe work that was half written.
 */
@Injectable()
export class BookingStatsFactRepository {
  async upsert(
    manager: EntityManager,
    rows: readonly BookingStatsFactRow[],
  ): Promise<void> {
    for (
      let start = 0;
      start < rows.length;
      start += bookingStatsUpsertChunkSize
    ) {
      const chunk = rows.slice(start, start + bookingStatsUpsertChunkSize);
      await manager.query(
        `INSERT INTO booking_stats_facts (${columns.join(', ')})
         VALUES ${chunk.map(() => rowPlaceholder).join(', ')}
         AS incoming
         ON DUPLICATE KEY UPDATE
         ${guardedAssignments}`,
        chunk.flatMap((row) => [
          row.bookingPublicId,
          row.bookingVersion,
          row.status,
          row.roomId,
          row.roomTypeId,
          row.checkIn,
          row.checkOut,
          row.priceAmount,
          row.currency,
          row.lastEventId,
          row.lastOccurredAt,
        ]),
      );
    }
  }
}
