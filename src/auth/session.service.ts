import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { authConfig } from '../config/auth.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { User } from '../users/entities/user.entity';
import { UserStatus } from '../users/entities/user.enums';
import { AccessTokenService } from './access-token.service';
import { AuthRedisService } from './auth-redis.service';
import { authErrors } from './auth.errors';
import { AuthSession } from './entities/auth-session.entity';
import { AuthenticatedPrincipal, IssuedSession } from './auth.types';

interface RefreshSuccess {
  type: 'success';
  session: AuthSession;
  refreshToken: string;
}

interface RefreshFailure {
  type: 'invalid' | 'inactive';
  revokedSessionId?: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly accessTokens: AccessTokenService,
    private readonly redis: AuthRedisService,
    @Inject(authConfig.KEY)
    private readonly configuration: ConfigType<typeof authConfig>,
  ) {}

  async create(user: User): Promise<IssuedSession> {
    await this.databaseConnection.ensureInitialized();
    return this.dataSource.transaction(async (manager) => {
      const lockedUser = await manager.findOne(User, {
        where: { id: user.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedUser) throw authErrors.sessionInvalid();
      return this.createWithManager(manager, lockedUser);
    });
  }

  async createWithManager(
    manager: EntityManager,
    user: User,
  ): Promise<IssuedSession> {
    if (user.status !== UserStatus.Active) throw authErrors.userInactive();
    const id = randomUUID();
    const refreshToken = createRefreshToken(id);
    const refreshExpiresAt = new Date(
      Date.now() + this.configuration.refreshTtlSeconds * 1_000,
    );
    const session = manager.create(AuthSession, {
      id,
      userId: user.id,
      user,
      refreshTokenHash: hashRefreshToken(refreshToken),
      refreshExpiresAt,
      revokedAt: null,
    });
    await manager.save(session);
    const access = await this.accessTokens.issue(user.id, id, user.role);
    return { ...access, refreshToken, refreshExpiresAt };
  }

  async refresh(rawToken: string | undefined): Promise<IssuedSession> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) throw authErrors.sessionInvalid();
    await this.databaseConnection.ensureInitialized();

    let result: RefreshSuccess | RefreshFailure;
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const session = await manager
          .createQueryBuilder(AuthSession, 'session')
          .innerJoinAndSelect('session.user', 'user')
          .setLock('pessimistic_write')
          .where('session.id = :id', { id: parsed.sessionId })
          .getOne();

        if (
          !session ||
          session.revokedAt ||
          session.refreshExpiresAt <= new Date()
        ) {
          return { type: 'invalid' };
        }
        if (
          !constantTimeHashMatches(rawToken as string, session.refreshTokenHash)
        ) {
          session.revokedAt = new Date();
          await manager.save(session);
          return { type: 'invalid', revokedSessionId: session.id };
        }
        if (session.user.status !== UserStatus.Active) {
          session.revokedAt = new Date();
          await manager.save(session);
          return { type: 'inactive', revokedSessionId: session.id };
        }

        const refreshToken = createRefreshToken(session.id);
        session.refreshTokenHash = hashRefreshToken(refreshToken);
        await manager.save(session);
        return { type: 'success', session, refreshToken };
      });
    } catch (error) {
      if (error instanceof Error && 'errorCode' in error) throw error;
      throw authErrors.authorizationUnavailable();
    }

    if (result.type !== 'success') {
      if (result.revokedSessionId) {
        await this.markRevoked(result.revokedSessionId);
      }
      if (result.type === 'inactive') throw authErrors.userInactive();
      throw authErrors.sessionInvalid();
    }

    const access = await this.accessTokens.issue(
      result.session.user.id,
      result.session.id,
      result.session.user.role,
    );
    return {
      ...access,
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.session.refreshExpiresAt,
    };
  }

  async authenticateAccessToken(
    token: string,
  ): Promise<AuthenticatedPrincipal> {
    const claims = await this.accessTokens.verify(token);
    const cachedRevocation = await this.redis.isRevoked(claims.sid);
    if (cachedRevocation === true) throw authErrors.sessionInvalid();

    try {
      await this.databaseConnection.ensureInitialized();
      const session = await this.dataSource
        .getRepository(AuthSession)
        .createQueryBuilder('session')
        .innerJoinAndSelect('session.user', 'user')
        .where('session.id = :sessionId', { sessionId: claims.sid })
        .andWhere('session.user_id = :userId', { userId: claims.sub })
        .getOne();
      if (
        !session ||
        session.revokedAt ||
        session.refreshExpiresAt <= new Date()
      ) {
        throw authErrors.sessionInvalid();
      }
      if (session.user.status !== UserStatus.Active) {
        throw authErrors.userInactive();
      }
      return {
        userId: session.user.id,
        sessionId: session.id,
        email: session.user.email,
        displayName: session.user.displayName,
        role: session.user.role,
        status: session.user.status,
      };
    } catch (error) {
      if (error instanceof Error && 'errorCode' in error) throw error;
      throw authErrors.authorizationUnavailable();
    }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.databaseConnection.ensureInitialized();
    try {
      await this.dataSource.transaction(async (manager) => {
        const session = await manager.findOne(AuthSession, {
          where: { id: sessionId },
          lock: { mode: 'pessimistic_write' },
        });
        if (session && !session.revokedAt) {
          session.revokedAt = new Date();
          await manager.save(session);
        }
      });
    } catch {
      throw authErrors.authorizationUnavailable();
    }
    await this.markRevoked(sessionId);
  }

  async markSessionsRevoked(sessionIds: string[]): Promise<void> {
    await Promise.all(sessionIds.map((id) => this.markRevoked(id)));
  }

  private async markRevoked(sessionId: string): Promise<void> {
    await this.redis.markRevoked(
      sessionId,
      this.configuration.jwt.accessTtlSeconds,
    );
  }
}

export function createRefreshToken(sessionId: string): string {
  return `${sessionId}.${randomBytes(32).toString('base64url')}`;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseRefreshToken(
  token: string | undefined,
): { sessionId: string } | undefined {
  if (!token) return undefined;
  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(
      token,
    );
  return match ? { sessionId: match[1].toLowerCase() } : undefined;
}

function constantTimeHashMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashRefreshToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
