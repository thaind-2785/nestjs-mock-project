import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { reportsConfig } from '../config/reports.config';

/**
 * The API half of the export boundary: validated configuration now, and the admin
 * create/poll endpoints in the slices that follow.
 *
 * It deliberately registers no queue, no Redis client, and no Worker Thread. The
 * request path writes the idempotency, job, and outbox rows in one transaction and
 * stops there; an HTTP handler that could reach Redis or start a generation would put
 * the CPU and heap this design exists to isolate back beside authentication and
 * booking traffic.
 */
@Module({
  imports: [ConfigModule.forFeature(reportsConfig)],
  exports: [ConfigModule],
})
export class ReportsApiModule {}
