import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxClaimRepository } from '../common/outbox/outbox-claim.repository';
import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { bookingStreamConfig } from '../config/booking-stream.config';
import { DatabaseModule } from '../database/database.module';
import { BOOKING_LIFECYCLE_PUBLISHER } from './booking-lifecycle-publisher';
import { BookingLifecycleRelayRepository } from './booking-lifecycle-relay.repository';
import { BookingLifecycleRelayService } from './booking-lifecycle-relay.service';
import { KafkaBookingLifecyclePublisher } from './kafka-booking-lifecycle-publisher';

/**
 * The worker half of the lifecycle stream: the relay and its Kafka adapter.
 *
 * It is deliberately absent from `AppModule`, like the notification boundary: the API
 * writes lifecycle rows through `BookingLifecycleRecorder` and never holds a Kafka
 * client. The publisher resolves to `null` while the stream is disabled, so a worker
 * that has not adopted the stream builds no client and starts no loop.
 *
 * The relay service is the publisher's one owner and closes it on shutdown.
 */
@Module({
  imports: [
    ConfigModule.forFeature(bookingStreamConfig),
    DatabaseModule,
    TypeOrmModule.forFeature([OutboxEvent]),
  ],
  providers: [
    OutboxClaimRepository,
    BookingLifecycleRelayRepository,
    {
      provide: BOOKING_LIFECYCLE_PUBLISHER,
      inject: [bookingStreamConfig.KEY],
      useFactory: (configuration: ConfigType<typeof bookingStreamConfig>) =>
        configuration.enabled
          ? new KafkaBookingLifecyclePublisher(configuration)
          : null,
    },
    BookingLifecycleRelayService,
  ],
  exports: [ConfigModule, BookingLifecycleRelayService],
})
export class BookingLifecycleStreamModule {}
