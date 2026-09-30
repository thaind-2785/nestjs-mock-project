import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { bookingStreamConfig } from '../config/booking-stream.config';
import { DatabaseModule } from '../database/database.module';
import { BOOKING_STATS_CONSUMER } from './booking-stats-consumer';
import { BookingStatsFactRepository } from './booking-stats-fact.repository';
import { BookingStatsProjectionService } from './booking-stats-projection.service';
import { BookingStatsFact } from './entities/booking-stats-fact.entity';
import { KafkaBookingStatsConsumer } from './kafka-booking-stats-consumer';

/**
 * The worker half of booking statistics: the `booking-stats` consumer group and the
 * projection it feeds (`JOB-02`).
 *
 * Separate from `ReportsWorkerModule`, which is gated by the export flag: statistics
 * follow the stream flag, and a deployment may run either without the other. The
 * consumer resolves to `null` while the stream is disabled, so nothing connects.
 */
@Module({
  imports: [
    ConfigModule.forFeature(bookingStreamConfig),
    DatabaseModule,
    TypeOrmModule.forFeature([BookingStatsFact]),
  ],
  providers: [
    BookingStatsFactRepository,
    {
      provide: BOOKING_STATS_CONSUMER,
      inject: [bookingStreamConfig.KEY],
      useFactory: (configuration: ConfigType<typeof bookingStreamConfig>) =>
        configuration.enabled
          ? new KafkaBookingStatsConsumer(configuration)
          : null,
    },
    BookingStatsProjectionService,
  ],
  exports: [BookingStatsProjectionService],
})
export class BookingStatsWorkerModule {}
