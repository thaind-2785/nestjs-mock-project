import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/app-config.module';
import { DatabaseModule } from '../database/database.module';
import { NotificationRedriveRepository } from './notification-redrive.repository';
import { NotificationRedriveService } from './notification-redrive.service';
import { SendAttemptRepository } from './send-attempt.repository';

/**
 * Operator tooling only: the database and the redrive path, and deliberately not
 * `NotificationsModule`.
 *
 * Importing the worker module here would be a quiet disaster. Its relay and consumer
 * start from `onApplicationBootstrap`, which `createApplicationContext` runs, so a
 * one-shot CLI would claim outbox events and open an SMTP connection on its way to
 * doing something else - and then exit mid-flight, leaving leases to expire. A CLI
 * that edits delivery state must not also be a delivery worker.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule],
  providers: [
    NotificationRedriveRepository,
    NotificationRedriveService,
    SendAttemptRepository,
  ],
  exports: [NotificationRedriveService],
})
export class NotificationOperationsModule {}
