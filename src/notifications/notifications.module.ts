import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from '../bookings/entities/outbox-event.entity';
import { notificationsConfig } from '../config/notifications.config';
import { DatabaseModule } from '../database/database.module';
import { EmailDelivery } from './entities/email-delivery.entity';

/**
 * The notification boundary as of `P5-T01`: it owns the validated delivery
 * configuration and nothing else yet. Templates (`P5-T03`), the outbox relay
 * (`P5-T04`), and the SMTP adapters (`P5-T05`) are registered here as their slices
 * land, so the worker context keeps importing one module rather than growing a
 * second wiring path.
 *
 * It is deliberately absent from `AppModule`: importing the API must never create an
 * SMTP transport or start consuming a queue.
 */
@Module({
  imports: [
    ConfigModule.forFeature(notificationsConfig),
    DatabaseModule,
    // The worker reads the outbox the booking module writes, and owns the delivery
    // record. Registering both here keeps the worker context independent of the API
    // module graph rather than borrowing the bookings registration.
    TypeOrmModule.forFeature([OutboxEvent, EmailDelivery]),
  ],
  exports: [ConfigModule, TypeOrmModule],
})
export class NotificationsModule {}
