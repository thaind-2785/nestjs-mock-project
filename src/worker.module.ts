import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsWorkerModule } from './reports/reports-worker.module';
import { RetentionWorkerModule } from './retention/retention-worker.module';

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
 *
 * Retention is a third resident and not an event family at all: nothing writes an outbox
 * row to ask for it, so it starts because a clock says the day turned rather than because
 * something happened. It shares the same rule as the other two - its own window, its own
 * lease, its own failure budget - and the drain bound below is the maximum across all
 * three.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    NotificationsModule,
    ReportsWorkerModule,
    RetentionWorkerModule,
  ],
})
export class WorkerModule {}
