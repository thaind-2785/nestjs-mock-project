import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { notificationsConfig } from '../config/notifications.config';

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
  imports: [ConfigModule.forFeature(notificationsConfig)],
  exports: [ConfigModule],
})
export class NotificationsModule {}
