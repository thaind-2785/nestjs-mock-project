import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { bookingStreamConfig } from '../config/booking-stream.config';
import { hotelDateSpanDays } from '../common/dates/hotel-date-span';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { bookingStatsMaxRangeDays } from './booking-stats.constants';
import { bookingStatsErrors } from './booking-stats.errors';
import { BookingStatsQueryRepository } from './booking-stats-query.repository';
import { summarizeBookingStats } from './booking-stats-report';
import type {
  BookingStatsQuery,
  BookingStatsReport,
} from './booking-stats.types';

/**
 * `ADMIN-RPT-01`: counts and projected revenue from the Kafka-fed read model.
 *
 * It never reads `bookings`. The numbers are the consumer's projection of the stream,
 * which is eventually consistent by design, and `asOf` says how far it has got.
 */
@Injectable()
export class BookingStatsReportService {
  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly queries: BookingStatsQueryRepository,
    @Inject(bookingStreamConfig.KEY)
    private readonly stream: ConfigType<typeof bookingStreamConfig>,
  ) {}

  async report(query: BookingStatsQuery): Promise<BookingStatsReport> {
    if (!this.stream.enabled) throw bookingStatsErrors.disabled();
    const days = hotelDateSpanDays(query.from, query.to);
    if (!(days >= 1 && days <= bookingStatsMaxRangeDays)) {
      throw bookingStatsErrors.rangeInvalid();
    }
    // The API opens its pool lazily; relying on some earlier guard having opened it would
    // make this endpoint correct only by accident of the request path.
    const { manager } = await this.database.ensureInitialized();
    const [rows, asOf] = await Promise.all([
      this.queries.aggregate(manager, query),
      this.queries.asOf(manager),
    ]);
    return {
      from: query.from,
      to: query.to,
      roomTypeId: query.roomTypeId ?? null,
      groupBy: query.groupBy ?? null,
      asOf: asOf?.toISOString() ?? null,
      ...summarizeBookingStats(rows),
    };
  }
}
