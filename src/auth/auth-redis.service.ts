import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { authConfig } from '../config/auth.config';
import { authErrors } from './auth.errors';
import { AUTH_REDIS_CLIENT } from './auth.tokens';
import { OAuthTransaction } from './auth.types';

/** The complete set of authentication budgets, so no caller can invent a scope. */
export type AuthRateLimitScope = 'google-start' | 'google-callback' | 'refresh';

@Injectable()
export class AuthRedisService implements OnApplicationShutdown {
  private connection: Promise<void> | undefined;
  private closed = false;

  constructor(
    @Inject(AUTH_REDIS_CLIENT) private readonly client: Redis,
    private readonly rateLimit: RateLimitService,
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

  /**
   * Authentication keeps its own budget and error contract while the counter itself
   * lives in the shared limiter. Scopes are namespaced so an auth budget can never
   * be spent by another surface that happens to pick the same scope name.
   */
  async assertRateLimit(
    scope: AuthRateLimitScope,
    discriminator: string,
  ): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.rateLimit.consume({
        scope: `auth-${scope}`,
        discriminator,
        max: this.configuration.rateLimit.max,
        windowSeconds: this.configuration.rateLimit.windowSeconds,
      });
    } catch {
      throw authErrors.authorizationUnavailable();
    }
    if (!allowed) throw authErrors.rateLimited();
  }

  onApplicationShutdown(): void {
    // A request that reaches this service after shutdown began must not reopen a
    // socket that keeps the process alive past its grace period.
    this.closed = true;
    this.client.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('Auth Redis client is closed');
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
