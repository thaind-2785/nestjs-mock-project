import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { attachmentsConfig } from '../config/attachments.config';
import { reportsConfig } from '../config/reports.config';
import { retentionConfig } from '../config/retention.config';
import { ObjectStorageModule } from '../common/storage/object-storage.module';
import { DatabaseModule } from '../database/database.module';
import { AttachmentStorageService } from '../files/storage/attachment-storage.service';
import { StorageCleanupService } from '../files/storage-cleanup.service';
import { RetentionBacklogService } from './retention-backlog.service';
import { RetentionDeleteRepository } from './retention-delete.repository';
import { RetentionDueRepository } from './retention-due.repository';
import { RetentionReportService } from './retention-report.service';
import { RetentionRunService } from './retention-run.service';
import { RetentionSchedulerService } from './retention-scheduler.service';
import { RetentionTasksService } from './retention-tasks.service';
import { retentionEntities } from './retention.entities';
import { ScheduledRunRepository } from './scheduled-run.repository';

/**
 * Retention on the worker, which is the only process allowed to run it unattended.
 *
 * The same providers the operator module has, plus the scheduler. They are listed twice
 * rather than shared through one module because the difference is the whole point: a
 * one-shot command must not start a scheduler on its way to answering a question, and
 * `createApplicationContext` runs `onApplicationBootstrap` whether the command wanted it
 * or not. The notification and export modules are split along the same line.
 *
 * The API imports neither. It must never gain a reason to hold a deletion transaction
 * against tables it is also serving reads from.
 */
@Module({
  imports: [
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
    RetentionBacklogService,
    RetentionDeleteRepository,
    RetentionDueRepository,
    RetentionReportService,
    RetentionRunService,
    RetentionSchedulerService,
    RetentionTasksService,
    ScheduledRunRepository,
  ],
})
export class RetentionWorkerModule {}
