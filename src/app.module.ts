import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpFoundationModule } from './common/http/http-foundation.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LocalizationModule } from './i18n/localization.module';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    LocalizationModule,
    HttpFoundationModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
