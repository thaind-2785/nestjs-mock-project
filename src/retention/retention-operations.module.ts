import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigModule } from '../config/app-config.module';
import { retentionConfig } from '../config/retention.config';
import { DatabaseModule } from '../database/database.module';
import { RetentionDueRepository } from './retention-due.repository';
import { RetentionReportService } from './retention-report.service';
import { ScheduledRunRepository } from './scheduled-run.repository';

/**
 * Operator tooling only: the database, the due queries, and the ledger.
 *
 * Deliberately not the scheduler, which `P7-T04` adds. A scheduler starts from
 * `onApplicationBootstrap`, which `createApplicationContext` runs, so a one-shot CLI
 * would begin ticking on its way to answering a question and then exit mid-run. The
 * notification operations module keeps its distance from the worker module for exactly
 * this reason, and this one inherits the rule before there is a worker to keep away
 * from.
 */
@Module({
  imports: [
    AppConfigModule,
    ConfigModule.forFeature(retentionConfig),
    DatabaseModule,
  ],
  providers: [
    RetentionDueRepository,
    RetentionReportService,
    ScheduledRunRepository,
  ],
  exports: [RetentionReportService],
})
export class RetentionOperationsModule {}
