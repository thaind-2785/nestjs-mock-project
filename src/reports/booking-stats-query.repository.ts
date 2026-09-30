import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { bookingStatsAggregateStatement } from './booking-stats-query.sql';
import type {
  BookingStatsAggregateRow,
  BookingStatsQuery,
} from './booking-stats.types';

/**
 * The report's two reads, both served by an index alone.
 *
 * The aggregate ranges over the leading column of `idx_booking_stats_facts_stay` and
 * reads only the columns that follow it, so it never touches a table row whatever the
 * range holds. It groups by status and currency rather than filtering to revenue
 * statuses in SQL, because counts need every status and one scan answers both.
 */
@Injectable()
export class BookingStatsQueryRepository {
  async aggregate(
    manager: EntityManager,
    query: BookingStatsQuery,
  ): Promise<BookingStatsAggregateRow[]> {
    const statement = bookingStatsAggregateStatement(query);
    return manager.query(statement.sql, statement.parameters);
  }

  /** The newest applied change, from the end of `idx_booking_stats_facts_occurred`. */
  async asOf(manager: EntityManager): Promise<Date | null> {
    const rows: Array<{ asOf: Date | string | null }> = await manager.query(
      'SELECT MAX(last_occurred_at) AS asOf FROM booking_stats_facts',
    );
    const value = rows[0]?.asOf ?? null;
    return value === null ? null : new Date(value);
  }
}
