import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { authConfig } from '../config/auth.config';
import { authErrors } from './auth.errors';
import { AUTH_REDIS_CLIENT } from './auth.tokens';
import { OAuthTransaction } from './auth.types';

const rateLimitScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

@Injectable()
export class AuthRedisService implements OnApplicationShutdown {
  private connection: Promise<void> | undefined;

  constructor(
    @Inject(AUTH_REDIS_CLIENT) private readonly client: Redis,
    @Inject(authConfig.KEY)
    private readonly configuration: ConfigType<typeof authConfig>,
  ) {}

  async storeOAuthTransaction(
    state: string,
    transaction: OAuthTransaction,
  ): Promise<void> {
    try {
      await this.ensureConnected();
      const result = await this.client.set(
        this.oauthKey(state),
        JSON.stringify(transaction),
        'EX',
        this.configuration.oauthTransactionTtlSeconds,
        'NX',
      );
      if (result !== 'OK') throw new Error('OAuth transaction collision');
    } catch {
      throw authErrors.authorizationUnavailable();
    }
  }

  async consumeOAuthTransaction(
    state: string,
  ): Promise<OAuthTransaction | undefined> {
    try {
      await this.ensureConnected();
      const value = await this.client.getdel(this.oauthKey(state));
      if (!value) return undefined;
      const candidate = JSON.parse(value) as Partial<OAuthTransaction>;
      if (
        typeof candidate.nonce !== 'string' ||
        typeof candidate.codeVerifier !== 'string'
      ) {
        return undefined;
      }
      return {
        nonce: candidate.nonce,
        codeVerifier: candidate.codeVerifier,
      };
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw authErrors.authorizationUnavailable();
    }
  }

  async isRevoked(sessionId: string): Promise<boolean | undefined> {
    try {
      await this.ensureConnected();
      return (await this.client.get(this.revocationKey(sessionId))) === '1';
    } catch {
      return undefined;
    }
  }

  async markRevoked(sessionId: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    try {
      await this.ensureConnected();
      await this.client.set(
        this.revocationKey(sessionId),
        '1',
        'EX',
        ttlSeconds,
      );
    } catch {
      // MySQL is authoritative. A cache miss/outage forces the guard to MySQL.
    }
  }

  async assertRateLimit(scope: string, discriminator: string): Promise<void> {
    const digest = createHash('sha256').update(discriminator).digest('hex');
    try {
      await this.ensureConnected();
      const current = Number(
        await this.client.eval(
          rateLimitScript,
          1,
          `${this.configuration.redisKeyPrefix}:rate:${scope}:${digest}`,
          String(this.configuration.rateLimit.windowSeconds),
        ),
      );
      if (current > this.configuration.rateLimit.max) {
        throw authErrors.rateLimited();
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'AUTH_RATE_LIMITED'
      ) {
        throw error;
      }
      throw authErrors.authorizationUnavailable();
    }
  }

  onApplicationShutdown(): void {
    this.client.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status === 'ready') return;
    if (!this.connection) {
      this.connection = this.client.connect().finally(() => {
        this.connection = undefined;
      });
    }
    await this.connection;
  }

  private oauthKey(state: string): string {
    return `${this.configuration.redisKeyPrefix}:oauth:${createHash('sha256').update(state).digest('hex')}`;
  }

  private revocationKey(sessionId: string): string {
    return `${this.configuration.redisKeyPrefix}:revoked:${sessionId}`;
  }
}
