import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsWorkerModule } from './reports/reports-worker.module';

/**
 * The background worker runs as its own Nest application context: no controllers, no
 * HTTP listener, and no import of `AppModule`. The API and the worker therefore fail,
 * restart, and scale independently, and an API process cannot acquire an outbox claim,
 * an SMTP connection, or an export queue by accident.
 *
 * It hosts two independent event families. They share this process and its database
 * pool, and nothing else: separate queues, separate Redis connections, separate claim
 * allowlists, and separate failure budgets, so a backlog of one cannot consume the
 * capacity of the other.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    NotificationsModule,
    ReportsWorkerModule,
  ],
})
export class WorkerModule {}
