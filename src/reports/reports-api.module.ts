import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from '../bookings/entities/idempotency-key.entity';
import { OutboxEvent } from '../bookings/entities/outbox-event.entity';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { bookingsConfig } from '../config/bookings.config';
import { reportsConfig } from '../config/reports.config';
import { DatabaseModule } from '../database/database.module';
import { AdminExportsController } from './admin-exports.controller';
import { ExportJob } from './entities/export-job.entity';
import { ExportJobRepository } from './export-job.repository';
import { RoomExportCreateRateLimitGuard } from './room-export-create-rate-limit.guard';
import { RoomExportService } from './room-export.service';

/**
 * The API half of the export boundary: the admin create endpoint and the transaction
 * behind it.
 *
 * It registers no queue, no Redis producer and no Worker Thread. The request writes
 * an idempotency row, an outbox event and a job, and stops there; an HTTP handler
 * that could reach Redis or start a generation would put the CPU and heap this whole
 * design isolates back beside authentication and booking traffic. The limiter's Redis
 * client is the one exception and is not the export queue: it is the shared
 * request-budget store every protected route already uses.
 */
@Module({
  imports: [
    ConfigModule.forFeature(reportsConfig),
    // The retention window for an idempotency row belongs to the table, which the
    // booking configuration already owns; a second value would let one operation
    // expire a key the other still considers claimable.
    ConfigModule.forFeature(bookingsConfig),
    DatabaseModule,
    IdempotencyModule,
    RateLimitModule,
    TypeOrmModule.forFeature([ExportJob, OutboxEvent, IdempotencyKey]),
  ],
  controllers: [AdminExportsController],
  providers: [
    RoomExportService,
    ExportJobRepository,
    RoomExportCreateRateLimitGuard,
  ],
  exports: [ConfigModule],
})
export class ReportsApiModule {}
