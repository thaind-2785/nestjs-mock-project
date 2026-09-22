import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { attachmentsConfig } from '../config/attachments.config';
import { AttachmentStorageService } from '../files/storage/attachment-storage.service';
import { StorageCleanupService } from '../files/storage-cleanup.service';
import { retentionEntities } from './retention.entities';
import { AppConfigModule } from '../config/app-config.module';
import { reportsConfig } from '../config/reports.config';
import { retentionConfig } from '../config/retention.config';
import { ObjectStorageModule } from '../common/storage/object-storage.module';
import { DatabaseModule } from '../database/database.module';
import { RetentionDeleteRepository } from './retention-delete.repository';
import { RetentionDueRepository } from './retention-due.repository';
import { RetentionReportService } from './retention-report.service';
import { RetentionRunService } from './retention-run.service';
import { RetentionTasksService } from './retention-tasks.service';
import { ScheduledRunRepository } from './scheduled-run.repository';

/**
 * Operator tooling: the database, the object store, the due queries, the deletions and
 * the ledger.
 *
 * `StorageCleanupService` is provided directly rather than by importing `FilesModule`,
 * so `storage-tasks` schedules Phase 3's service without dragging the attachment API
 * into a command that has no HTTP surface. Importing the module whole was tried first
 * and failed at the first query with `EntityMetadataNotFoundError`: `Attachment`
 * declares a relation to `User`, `autoLoadEntities` only sees what a module registered,
 * and neither was. `retentionEntities` names the set instead.
 *
 * Deliberately not the scheduler, which `P7-T04` adds. A scheduler starts from
 * `onApplicationBootstrap`, which `createApplicationContext` runs, so a one-shot CLI
 * would begin ticking on its way to doing one thing and then exit mid-run. The
 * notification operations module keeps its distance from the worker module for exactly
 * this reason.
 */
@Module({
  imports: [
    AppConfigModule,
    ConfigModule.forFeature(retentionConfig),
    ConfigModule.forFeature(reportsConfig),
    ConfigModule.forFeature(attachmentsConfig),
    DatabaseModule,
    ObjectStorageModule,
    TypeOrmModule.forFeature(retentionEntities),
  ],
  providers: [
    AttachmentStorageService,
    StorageCleanupService,
    RetentionDeleteRepository,
    RetentionDueRepository,
    RetentionReportService,
    RetentionRunService,
    RetentionTasksService,
    ScheduledRunRepository,
  ],
  exports: [RetentionReportService, RetentionRunService],
})
export class RetentionOperationsModule {}
