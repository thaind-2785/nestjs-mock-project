import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { AppConfigModule } from '../config/app-config.module';
import { bookingStreamConfig } from '../config/booking-stream.config';
import { DatabaseModule } from '../database/database.module';
import { BOOKING_STATS_OFFSETS } from './booking-stats-offsets';
import { BookingStatsRebuildService } from './booking-stats-rebuild.service';
import { KafkaBookingStatsOffsets } from './kafka-booking-stats-offsets';

/**
 * What the rebuild command needs and nothing more: the database, and an admin client
 * for the statistics group. It starts no consumer and no relay.
 */
@Module({
  imports: [
    AppConfigModule,
    ConfigModule.forFeature(bookingStreamConfig),
    DatabaseModule,
  ],
  providers: [
    {
      provide: BOOKING_STATS_OFFSETS,
      inject: [bookingStreamConfig.KEY],
      useFactory: (configuration: ConfigType<typeof bookingStreamConfig>) =>
        new KafkaBookingStatsOffsets(configuration),
    },
    BookingStatsRebuildService,
  ],
})
export class BookingStatsOperationsModule {}
