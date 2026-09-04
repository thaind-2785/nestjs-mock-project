import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { validateSync } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { authConfig } from '../config/auth.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { User } from '../users/entities/user.entity';
import { UserRole, UserStatus } from '../users/entities/user.enums';
import { AuthRedisService } from './auth-redis.service';
import { authErrors } from './auth.errors';
import {
  GoogleCallbackQueryDto,
  googleCallbackProviderValidationGroup,
  googleCallbackStateValidationGroup,
} from './dto/google-callback-query.dto';
import { AuthIdentity, AuthProvider } from './entities/auth-identity.entity';
import type {
  GoogleOAuthClientContract,
  GoogleAuthorizationRequest,
} from './google/google-oauth.client';
import { SessionService } from './session.service';
import { GOOGLE_OAUTH_CLIENT } from './auth.tokens';
import { GoogleIdentityClaims, IssuedSession } from './auth.types';

export interface GoogleLoginStart {
  authorizationUrl: string;
  state: string;
}

export interface GoogleCallbackContext {
  cookieState?: string;
  rateLimitKey: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly redis: AuthRedisService,
    private readonly sessions: SessionService,
    @Inject(GOOGLE_OAUTH_CLIENT)
    private readonly google: GoogleOAuthClientContract,
    @Inject(authConfig.KEY)
    private readonly configuration: ConfigType<typeof authConfig>,
  ) {}

  async beginGoogleLogin(rateLimitKey: string): Promise<GoogleLoginStart> {
    await this.redis.assertRateLimit('google-start', rateLimitKey);
    const request = createGoogleAuthorizationRequest();
    await this.redis.storeOAuthTransaction(request.state, {
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
    });
    try {
      return {
        authorizationUrl: this.google.createAuthorizationUrl(request),
        state: request.state,
      };
    } catch (error) {
      await this.redis.consumeOAuthTransaction(request.state);
      throw error;
    }
  }

  async completeGoogleLogin(
    query: GoogleCallbackQueryDto,
    context: GoogleCallbackContext,
  ): Promise<IssuedSession> {
    await this.redis.assertRateLimit('google-callback', context.rateLimitKey);
    const queryState = validatedQueryState(query);
    if (!context.cookieState || !safeEqual(queryState, context.cookieState)) {
      throw authErrors.oauthTransactionInvalid();
    }
    const transaction = await this.redis.consumeOAuthTransaction(queryState);
    if (!transaction) throw authErrors.oauthTransactionInvalid();

    // Validate the provider result only after consuming a matching transaction.
    // A single-use OAuth state must stay consumed even when code/error is malformed;
    // validating the entire DTO in Nest's global pipe would return too early.
    const code = validatedAuthorizationCode(query);

    const claims = await this.google.exchangeAndVerify({
      code,
      codeVerifier: transaction.codeVerifier,
      expectedNonce: transaction.nonce,
    });
    await this.databaseConnection.ensureInitialized();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.resolveIdentityAndCreateSession(claims);
      } catch (error) {
        if (!isRetryableIdentityRace(error)) throw error;
        if (attempt === 2) throw authErrors.identityConflict();
        await waitForIdentityWinner((attempt + 1) * 10);
      }
    }
    throw authErrors.identityConflict();
  }

  get successRedirectUri(): string {
    return this.configuration.google.successRedirectUri;
  }

  async assertRateLimit(scope: string, key: string): Promise<void> {
    await this.redis.assertRateLimit(scope, key);
  }

  private async resolveIdentityAndCreateSession(
    claims: GoogleIdentityClaims,
  ): Promise<IssuedSession> {
    return this.dataSource.transaction(async (manager) => {
      const identity = await manager.findOne(AuthIdentity, {
        where: {
          provider: AuthProvider.Google,
          providerSubject: claims.subject,
        },
        relations: { user: true },
        lock: { mode: 'pessimistic_write' },
      });

      if (identity) {
        return this.updateReturningIdentity(manager, identity, claims);
      }

      const emailOwner = await manager.findOne(User, {
        where: { email: claims.email },
        lock: { mode: 'pessimistic_read' },
      });
      if (emailOwner) throw authErrors.identityConflict();

      const user = await manager.save(
        manager.create(User, {
          email: claims.email,
          displayName: claims.displayName,
          role: UserRole.User,
          status: UserStatus.Active,
          emailVerifiedAt: new Date(),
        }),
      );
      await manager.save(
        manager.create(AuthIdentity, {
          userId: user.id,
          user,
          provider: AuthProvider.Google,
          providerSubject: claims.subject,
          providerEmail: claims.email,
        }),
      );
      return this.sessions.createWithManager(manager, user);
    });
  }

  private async updateReturningIdentity(
    manager: EntityManager,
    identity: AuthIdentity,
    claims: GoogleIdentityClaims,
  ): Promise<IssuedSession> {
    const user = identity.user;
    if (user.status !== UserStatus.Active) throw authErrors.userInactive();

    if (user.email !== claims.email) {
      const emailOwner = await manager.findOne(User, {
        where: { email: claims.email },
        lock: { mode: 'pessimistic_read' },
      });
      if (emailOwner && emailOwner.id !== user.id) {
        throw authErrors.identityConflict();
      }
      user.email = claims.email;
      await manager.save(user);
    }
    if (identity.providerEmail !== claims.email) {
      identity.providerEmail = claims.email;
      await manager.save(identity);
    }
    return this.sessions.createWithManager(manager, user);
  }
}

function validatedQueryState(query: GoogleCallbackQueryDto): string {
  const errors = validateSync(query, {
    groups: [googleCallbackStateValidationGroup],
  });
  if (errors.length > 0) throw authErrors.oauthTransactionInvalid();
  return query.state as string;
}

function validatedAuthorizationCode(query: GoogleCallbackQueryDto): string {
  const errors = validateSync(query, {
    groups: [googleCallbackProviderValidationGroup],
  });
  if (
    errors.length > 0 ||
    query.error !== undefined ||
    typeof query.code !== 'string' ||
    !query.code.trim()
  ) {
    throw authErrors.googleAuthenticationFailed();
  }
  return query.code;
}

function createGoogleAuthorizationRequest(): GoogleAuthorizationRequest & {
  codeVerifier: string;
} {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  return {
    state,
    nonce,
    codeVerifier,
    codeChallenge: createHash('sha256')
      .update(codeVerifier)
      .digest('base64url'),
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isRetryableIdentityRace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };
  const code = candidate.code ?? candidate.driverError?.code;
  return code === 'ER_DUP_ENTRY' || code === 'ER_LOCK_DEADLOCK';
}

function waitForIdentityWinner(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
}
