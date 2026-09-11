import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { bookingsConfig } from '../config/bookings.config';
import { DatabaseModule } from '../database/database.module';
import { BookingChangeHistory } from './entities/booking-change-history.entity';
import { BookingStatusHistory } from './entities/booking-status-history.entity';
import { Booking } from './entities/booking.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { BookingCreateRateLimitGuard } from './booking-create-rate-limit.guard';
import { BookingsController } from './bookings.controller';
import { AdminBookingsController } from './admin-bookings.controller';
import { BookingsService } from './bookings.service';

/** P4-T02 exposes the first booking mutation after P4-T01 established its schema. */
@Module({
  imports: [
    ConfigModule.forFeature(bookingsConfig),
    DatabaseModule,
    RateLimitModule,
    TypeOrmModule.forFeature([
      Booking,
      BookingStatusHistory,
      BookingChangeHistory,
      IdempotencyKey,
      OutboxEvent,
    ]),
  ],
  controllers: [BookingsController, AdminBookingsController],
  providers: [BookingsService, BookingCreateRateLimitGuard],
})
export class BookingsModule {}
