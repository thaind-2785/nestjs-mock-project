import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { authConfig } from '../config/auth.config';
import { readinessConfig } from '../config/readiness.config';
import { DatabaseModule } from '../database/database.module';
import { UserRoleHistory } from '../users/entities/user-role-history.entity';
import { UserStatusHistory } from '../users/entities/user-status-history.entity';
import { User } from '../users/entities/user.entity';
import { AccessTokenService } from './access-token.service';
import { AuthRedisService } from './auth-redis.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthIdentity } from './entities/auth-identity.entity';
import { AuthSession } from './entities/auth-session.entity';
import { GoogleOAuthClient } from './google/google-oauth.client';
import { AccessTokenGuard } from './guards/access-token.guard';
import { RolesGuard } from './guards/roles.guard';
import { SessionService } from './session.service';
import { AUTH_REDIS_CLIENT, GOOGLE_OAUTH_CLIENT } from './auth.tokens';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    ConfigModule.forFeature(readinessConfig),
    DatabaseModule,
    JwtModule.register({}),
    TypeOrmModule.forFeature([
      User,
      AuthIdentity,
      AuthSession,
      UserStatusHistory,
      UserRoleHistory,
    ]),
  ],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    AuthRedisService,
    AuthService,
    SessionService,
    {
      provide: AUTH_REDIS_CLIENT,
      inject: [readinessConfig.KEY],
      useFactory: (configuration: ConfigType<typeof readinessConfig>) =>
        new Redis({
          host: configuration.redis.host,
          port: configuration.redis.port,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: configuration.timeoutMs,
          retryStrategy: () => null,
        }),
    },
    { provide: GOOGLE_OAUTH_CLIENT, useClass: GoogleOAuthClient },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthRedisService, SessionService],
})
export class AuthModule {}
