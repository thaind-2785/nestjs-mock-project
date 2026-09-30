import type {
  BookingStatsGrouping,
  BookingStatsQuery,
} from './booking-stats.types';

/**
 * The bucket expression per grouping. Fixed strings chosen by an enum the DTO already
 * validated, never interpolated from input.
 */
const periodExpressions: Record<BookingStatsGrouping | 'none', string> = {
  none: 'NULL',
  day: "DATE_FORMAT(check_in, '%Y-%m-%d')",
  month: "DATE_FORMAT(check_in, '%Y-%m-01')",
};

/**
 * The report's aggregate as SQL and parameters, built once. The repository sends it and
 * the integration suite `EXPLAIN`s exactly this, so the index evidence is about the query
 * that runs rather than a copy of it.
 */
export function bookingStatsAggregateStatement(query: BookingStatsQuery): {
  sql: string;
  parameters: string[];
} {
  const period = periodExpressions[query.groupBy ?? 'none'];
  const roomType = query.roomTypeId ? 'AND room_type_id = ?' : '';
  return {
    sql: `SELECT ${period} AS period, status, currency,
                 COUNT(*) AS bookings, SUM(price_amount) AS amount
          FROM booking_stats_facts
          WHERE check_in >= ? AND check_in < ? ${roomType}
          GROUP BY period, status, currency
          ORDER BY period ASC, status ASC, currency ASC`,
    parameters: [
      query.from,
      query.to,
      ...(query.roomTypeId ? [query.roomTypeId] : []),
    ],
  };
}
