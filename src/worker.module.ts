import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { NotificationsModule } from './notifications/notifications.module';
import { WorkerHeartbeat } from './worker-heartbeat';

/**
 * The notification worker runs as its own Nest application context: no controllers,
 * no HTTP listener, and no import of `AppModule`. The API and the worker therefore
 * fail, restart, and scale independently, and an API process cannot acquire an
 * outbox claim or an SMTP connection by accident.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, NotificationsModule],
  providers: [WorkerHeartbeat],
})
export class WorkerModule {}
