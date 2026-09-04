import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { AccessTokenService } from '../src/auth/access-token.service';
import { AuthRedisService } from '../src/auth/auth-redis.service';
import { AuthService } from '../src/auth/auth.service';
import { GoogleCallbackQueryDto } from '../src/auth/dto/google-callback-query.dto';
import { AuthIdentity } from '../src/auth/entities/auth-identity.entity';
import { AuthSession } from '../src/auth/entities/auth-session.entity';
import type {
  GoogleAuthorizationRequest,
  GoogleCodeExchange,
  GoogleOAuthClientContract,
} from '../src/auth/google/google-oauth.client';
import type { GoogleIdentityClaims } from '../src/auth/auth.types';
import { SessionService } from '../src/auth/session.service';
import { createAuthConfiguration } from '../src/config/auth.config';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { DatabaseConnectionService } from '../src/database/database-connection.service';
import { createTypeOrmOptions } from '../src/database/database.options';
import { CreateAuthRbacSchema1788380000000 } from '../src/database/migrations/1788380000000-CreateAuthRbacSchema';
import { AdminBootstrapService } from '../src/users/admin-bootstrap.service';
import { UserRoleHistory } from '../src/users/entities/user-role-history.entity';
import { UserStatusHistory } from '../src/users/entities/user-status-history.entity';
import { User } from '../src/users/entities/user.entity';
import { UserRole, UserStatus } from '../src/users/entities/user.enums';
import { UsersService } from '../src/users/users.service';

jest.setTimeout(30_000);

describe('Auth and RBAC persistence', () => {
  let dataSource: DataSource;
  let adminConnection: mysql.Connection;
  let disposableDatabase: string;
  let redisClient: Redis;
  let authRedis: AuthRedisService;
  let sessions: SessionService;
  let users: UsersService;
  let bootstrapAdmin: AdminBootstrapService;
  let googleClaims: GoogleIdentityClaims;
  let auth: AuthService;
  const authConfiguration = createAuthConfiguration(
    validateEnvironment({
      NODE_ENV: 'test',
      AUTH_REDIS_KEY_PREFIX: `hotel:test:${process.pid}:${randomUUID().replaceAll('-', '')}`,
    }),
  );

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p2_auth_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    try {
      adminConnection = await mysql.createConnection({
        host: environment.MYSQL_HOST,
        port: environment.MYSQL_PORT,
        user: 'root',
        password:
          process.env.MYSQL_ROOT_PASSWORD ?? 'local_mysql_root_change_me',
      });
      await adminConnection.query(
        `CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      await adminConnection.query(
        `GRANT ALL PRIVILEGES ON \`${disposableDatabase}\`.* TO '${environment.MYSQL_USER}'@'%'`,
      );
    } catch (error) {
      throw new Error(
        `MySQL auth integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(
        createDatabaseConfiguration({
          ...environment,
          MYSQL_DATABASE: disposableDatabase,
        }),
        {
          entities: [
            User,
            AuthIdentity,
            AuthSession,
            UserStatusHistory,
            UserRoleHistory,
          ],
          migrations: [CreateAuthRbacSchema1788380000000],
          migrationsTableName: 'p2_auth_migrations',
        },
      ),
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    redisClient = new Redis({
      host: environment.REDIS_HOST,
      port: environment.REDIS_PORT,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    authRedis = new AuthRedisService(redisClient, authConfiguration);
    const databaseConnection = new DatabaseConnectionService(dataSource);
    const accessTokens = new AccessTokenService(
      new JwtService(),
      authConfiguration,
    );
    sessions = new SessionService(
      dataSource,
      databaseConnection,
      accessTokens,
      authRedis,
      authConfiguration,
    );
    users = new UsersService(
      dataSource,
      databaseConnection,
      authRedis,
      authConfiguration,
    );
    bootstrapAdmin = new AdminBootstrapService(dataSource, databaseConnection);
    googleClaims = {
      subject: 'integration-google-subject',
      email: 'jit@example.com',
      displayName: 'JIT User',
    };
    const google: GoogleOAuthClientContract = {
      createAuthorizationUrl: (request: GoogleAuthorizationRequest) =>
        `https://accounts.google.test/authorize?state=${request.state}`,
      exchangeAndVerify: (request: GoogleCodeExchange) => {
        void request;
        return Promise.resolve(googleClaims);
      },
    };
    auth = new AuthService(
      dataSource,
      databaseConnection,
      authRedis,
      sessions,
      google,
      authConfiguration,
    );
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM user_role_history');
    await dataSource.query('DELETE FROM user_status_history');
    await dataSource.query('DELETE FROM auth_sessions');
    await dataSource.query('DELETE FROM auth_identities');
    await dataSource.query('DELETE FROM users');
  });

  it('creates the constrained production auth schema with synchronize disabled', async () => {
    expect(dataSource.options.synchronize).toBe(false);
    expect(dataSource.options.timezone).toBe('Z');
    const tables = await dataSource.query<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.tables
       WHERE table_schema = DATABASE() AND TABLE_NAME IN
       ('users','auth_identities','auth_sessions','user_status_history','user_role_history')
       ORDER BY TABLE_NAME`,
    );
    expect(tables.map((row) => row.TABLE_NAME)).toEqual([
      'auth_identities',
      'auth_sessions',
      'user_role_history',
      'user_status_history',
      'users',
    ]);
  });

  it('round-trips auth timestamps as UTC instants', async () => {
    const verifiedAt = new Date('2026-01-02T03:04:05.678Z');
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: 'utc@example.com',
        displayName: 'UTC User',
        role: UserRole.User,
        status: UserStatus.Active,
        emailVerifiedAt: verifiedAt,
      }),
    );

    const loaded = await dataSource.getRepository(User).findOneByOrFail({
      id: user.id,
    });
    expect(loaded.emailVerifiedAt.toISOString()).toBe(
      '2026-01-02T03:04:05.678Z',
    );
    expect(loaded.createdAt).toBeInstanceOf(Date);
    expect(loaded.updatedAt).toBeInstanceOf(Date);
  });

  it('atomically rotates once under concurrent refresh and revokes on reuse', async () => {
    const user = await createUser('refresh@example.com');
    const issued = await sessions.create(user);
    const attempts = await Promise.allSettled([
      sessions.refresh(issued.refreshToken),
      sessions.refresh(issued.refreshToken),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === 'rejected'),
    ).toHaveLength(1);
    const stored = await dataSource.getRepository(AuthSession).findOneByOrFail({
      id: issued.refreshToken.split('.')[0],
    });
    expect(stored.revokedAt).toBeInstanceOf(Date);
  });

  it('provisions once by Google subject and never overwrites the app display name', async () => {
    const first = await completeGoogleLogin('jit-first');
    googleClaims = {
      ...googleClaims,
      email: 'JIT-UPDATED@example.com',
      displayName: 'Google Renamed User',
    };
    const returning = await completeGoogleLogin('jit-returning');

    expect(first.accessToken).toEqual(expect.any(String));
    expect(returning.accessToken).toEqual(expect.any(String));
    expect(await dataSource.getRepository(User).count()).toBe(1);
    expect(await dataSource.getRepository(AuthIdentity).count()).toBe(1);
    const user = await dataSource.getRepository(User).findOneByOrFail({
      email: 'jit-updated@example.com',
    });
    expect(user.displayName).toBe('JIT User');
  });

  it('converges concurrent first callbacks on one Google identity', async () => {
    const first = await auth.beginGoogleLogin('concurrent-first-start');
    const second = await auth.beginGoogleLogin('concurrent-second-start');
    const attempts = await Promise.allSettled([
      auth.completeGoogleLogin(
        GoogleCallbackQueryDto.fromQuery({
          code: randomUUID(),
          state: first.state,
        }),
        {
          cookieState: first.state,
          rateLimitKey: 'concurrent-first-callback',
        },
      ),
      auth.completeGoogleLogin(
        GoogleCallbackQueryDto.fromQuery({
          code: randomUUID(),
          state: second.state,
        }),
        {
          cookieState: second.state,
          rateLimitKey: 'concurrent-second-callback',
        },
      ),
    ]);

    const rejection = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === 'rejected',
    );
    if (rejection) {
      const reason: unknown = rejection.reason;
      if (reason instanceof Error) throw reason;
      throw new Error('Concurrent JIT callback failed');
    }
    expect(await dataSource.getRepository(User).count()).toBe(1);
    expect(await dataSource.getRepository(AuthIdentity).count()).toBe(1);
    expect(await dataSource.getRepository(AuthSession).count()).toBe(2);
  });

  it('rejects a new Google subject whose normalized email is already owned', async () => {
    await createUser('claimed@example.com');
    googleClaims = {
      subject: 'different-google-subject',
      email: 'claimed@example.com',
      displayName: 'Collision',
    };

    await expect(completeGoogleLogin('collision')).rejects.toMatchObject({
      errorCode: 'IDENTITY_CONFLICT',
    });
    expect(await dataSource.getRepository(AuthIdentity).count()).toBe(0);
    expect(await dataSource.getRepository(AuthSession).count()).toBe(0);
  });

  it('consumes each browser OAuth transaction exactly once', async () => {
    const state = randomUUID();
    await authRedis.storeOAuthTransaction(state, {
      nonce: 'nonce',
      codeVerifier: 'verifier',
    });

    await expect(authRedis.consumeOAuthTransaction(state)).resolves.toEqual({
      nonce: 'nonce',
      codeVerifier: 'verifier',
    });
    await expect(
      authRedis.consumeOAuthTransaction(state),
    ).resolves.toBeUndefined();
  });

  it('bootstraps the first admin idempotently and appends one role audit', async () => {
    const user = await createUser('admin@example.com');
    await expect(
      bootstrapAdmin.promote({
        userId: user.id,
        email: 'ADMIN@example.com',
        reason: 'Initial production administrator',
      }),
    ).resolves.toBe('promoted');
    await expect(
      bootstrapAdmin.promote({
        userId: user.id,
        email: user.email,
        reason: 'Idempotent retry',
      }),
    ).resolves.toBe('already-admin');

    expect(
      (await dataSource.getRepository(User).findOneByOrFail({ id: user.id }))
        .role,
    ).toBe(UserRole.Admin);
    const roleHistory = await dataSource
      .getRepository(UserRoleHistory)
      .findOneByOrFail({ userId: user.id });
    expect(roleHistory.createdAt).toBeInstanceOf(Date);
  });

  it('rejects bootstrap for missing, mismatched, and inactive accounts', async () => {
    const user = await createUser('bootstrap-policy@example.com');
    await expect(
      bootstrapAdmin.promote({
        userId: '999999999',
        email: user.email,
        reason: 'Missing user',
      }),
    ).rejects.toMatchObject({ code: 'USER_IDENTITY_MISMATCH' });
    await expect(
      bootstrapAdmin.promote({
        userId: user.id,
        email: 'another@example.com',
        reason: 'Mismatched email',
      }),
    ).rejects.toMatchObject({ code: 'USER_IDENTITY_MISMATCH' });

    user.status = UserStatus.Inactive;
    await dataSource.getRepository(User).save(user);
    await expect(
      bootstrapAdmin.promote({
        userId: user.id,
        email: user.email,
        reason: 'Inactive user',
      }),
    ).rejects.toMatchObject({ code: 'USER_INACTIVE' });
    expect(await dataSource.getRepository(UserRoleHistory).count()).toBe(0);
  });

  it('audits inactivation and revokes every active session in one transaction', async () => {
    const admin = await createUser('admin@example.com', UserRole.Admin);
    const target = await createUser('target@example.com');
    const issued = await sessions.create(target);

    await users.updateStatus({
      actorUserId: admin.id,
      targetUserId: target.id,
      status: UserStatus.Inactive,
      reason: 'Policy violation',
    });

    expect(
      (await dataSource.getRepository(User).findOneByOrFail({ id: target.id }))
        .status,
    ).toBe(UserStatus.Inactive);
    const statusHistory = await dataSource
      .getRepository(UserStatusHistory)
      .findOneByOrFail({ userId: target.id });
    expect(statusHistory.createdAt).toBeInstanceOf(Date);
    expect(
      (
        await dataSource.getRepository(AuthSession).findOneByOrFail({
          id: issued.refreshToken.split('.')[0],
        })
      ).revokedAt,
    ).toBeInstanceOf(Date);
    await expect(
      sessions.authenticateAccessToken(issued.accessToken),
    ).rejects.toMatchObject({ errorCode: 'SESSION_INVALID' });
  });

  it('prevents self-deactivation and deactivating the last active admin', async () => {
    const admin = await createUser('only-admin@example.com', UserRole.Admin);
    await expect(
      users.updateStatus({
        actorUserId: admin.id,
        targetUserId: admin.id,
        status: UserStatus.Inactive,
        reason: 'Self action',
      }),
    ).rejects.toMatchObject({ errorCode: 'SELF_DEACTIVATION_FORBIDDEN' });

    const actor = await createUser('operator@example.com');
    await expect(
      users.updateStatus({
        actorUserId: actor.id,
        targetUserId: admin.id,
        status: UserStatus.Inactive,
        reason: 'Would remove last admin',
      }),
    ).rejects.toMatchObject({
      errorCode: 'LAST_ADMIN_DEACTIVATION_FORBIDDEN',
    });
  });

  it('falls back to durable MySQL when the positive revocation cache is unavailable', async () => {
    const user = await createUser('fallback@example.com');
    const issued = await sessions.create(user);
    const redisUnavailable = {
      isRevoked: jest.fn().mockResolvedValue(undefined),
      markRevoked: jest.fn(),
    } as unknown as AuthRedisService;
    const fallbackSessions = new SessionService(
      dataSource,
      new DatabaseConnectionService(dataSource),
      new AccessTokenService(new JwtService(), authConfiguration),
      redisUnavailable,
      authConfiguration,
    );

    const principal = await fallbackSessions.authenticateAccessToken(
      issued.accessToken,
    );
    expect(principal.userId).toBe(user.id);
    expect(typeof principal.sessionId).toBe('string');
  });

  it('reverts and reapplies the production migration cleanly', async () => {
    await dataSource.undoLastMigration();
    const tables = await dataSource.query<Array<{ TABLE_NAME: string }>>(
      `SELECT TABLE_NAME FROM information_schema.tables
       WHERE table_schema = DATABASE() AND TABLE_NAME = 'users'`,
    );
    expect(tables).toHaveLength(0);
    await dataSource.runMigrations();
  });

  async function completeGoogleLogin(rateLimitKey: string) {
    const started = await auth.beginGoogleLogin(`${rateLimitKey}-start`);
    return auth.completeGoogleLogin(
      GoogleCallbackQueryDto.fromQuery({
        code: randomUUID(),
        state: started.state,
      }),
      {
        cookieState: started.state,
        rateLimitKey: `${rateLimitKey}-callback`,
      },
    );
  }

  async function createUser(
    email: string,
    role = UserRole.User,
  ): Promise<User> {
    return dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email,
        displayName: email.split('@')[0],
        role,
        status: UserStatus.Active,
        emailVerifiedAt: new Date(),
      }),
    );
  }

  afterAll(async () => {
    if (redisClient?.status === 'ready') {
      const keys = await redisClient.keys(
        `${authConfiguration.redisKeyPrefix}:*`,
      );
      if (keys.length) await redisClient.del(...keys);
    }
    authRedis?.onApplicationShutdown();
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (adminConnection && disposableDatabase) {
      try {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
        );
      } finally {
        await adminConnection.end();
      }
    }
  });
});
