import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { bookingsConfig } from '../config/bookings.config';
import { DatabaseModule } from '../database/database.module';
import { BookingChangeHistory } from './entities/booking-change-history.entity';
import { BookingStatusHistory } from './entities/booking-status-history.entity';
import { Booking } from './entities/booking.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { OutboxEvent } from './entities/outbox-event.entity';

/**
 * P4-T01 registers only booking persistence/configuration. HTTP use cases arrive in
 * later vertical slices so the schema can be migration-tested in isolation first.
 */
@Module({
  imports: [
    ConfigModule.forFeature(bookingsConfig),
    DatabaseModule,
    TypeOrmModule.forFeature([
      Booking,
      BookingStatusHistory,
      BookingChangeHistory,
      IdempotencyKey,
      OutboxEvent,
    ]),
  ],
})
export class BookingsModule {}
