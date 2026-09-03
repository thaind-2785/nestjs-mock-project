import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { HttpFoundationModule } from './common/http/http-foundation.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LocalizationModule } from './i18n/localization.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    AuthModule,
    DatabaseModule,
    LocalizationModule,
    HttpFoundationModule,
    HealthModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
