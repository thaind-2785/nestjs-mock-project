import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module';
import { reportRedisClientErrors } from '../common/redis/redis-client-errors';
import { authConfig } from '../config/auth.config';
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
    DatabaseModule,
    JwtModule.register({}),
    RateLimitModule,
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
      inject: [authConfig.KEY],
      useFactory: (configuration: ConfigType<typeof authConfig>) => {
        const client = new Redis({
          host: configuration.redisConnection.host,
          port: configuration.redisConnection.port,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 0,
          connectTimeout: configuration.redisConnection.timeoutMs,
          commandTimeout: configuration.redisConnection.timeoutMs,
          maxLoadingRetryTime: configuration.redisConnection.timeoutMs,
          retryStrategy: () => null,
        });
        reportRedisClientErrors(client, 'auth-state');
        return client;
      },
    },
    { provide: GOOGLE_OAUTH_CLIENT, useClass: GoogleOAuthClient },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthRedisService, SessionService],
})
export class AuthModule {}
