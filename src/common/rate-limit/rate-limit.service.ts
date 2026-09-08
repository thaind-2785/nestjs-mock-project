import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';
import { rateLimitConfig } from '../../config/rate-limit.config';
import { RATE_LIMIT_REDIS_CLIENT } from './rate-limit.tokens';

const fixedWindowRateLimitScript = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

/**
 * Scopes are part of a Redis key and must never carry caller text. Every current
 * caller passes a literal; this keeps a future one from forging or crossing a
 * namespace by forwarding a request field.
 */
const allowedScope = /^[a-z0-9-]{1,64}$/;

export interface RateLimitAttempt {
  scope: string;
  discriminator: string;
  max: number;
  windowSeconds: number;
}

export class RateLimitStoreUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super('Rate-limit storage is unavailable', { cause });
    this.name = 'RateLimitStoreUnavailableError';
  }
}

/**
 * One shared, fail-closed Redis fixed-window primitive. Domain callers choose the
 * policy and map the result to their own stable error contract; raw discriminators
 * are hashed before they enter Redis and never appear in logs.
 */
@Injectable()
export class RateLimitService implements OnApplicationShutdown {
  private readonly logger = new Logger(RateLimitService.name);
  private connection: Promise<void> | undefined;
  private closed = false;

  public constructor(
    @Inject(RATE_LIMIT_REDIS_CLIENT) private readonly client: Redis,
    @Inject(rateLimitConfig.KEY)
    private readonly configuration: ConfigType<typeof rateLimitConfig>,
  ) {}

  public async consume(attempt: RateLimitAttempt): Promise<boolean> {
    if (!allowedScope.test(attempt.scope)) {
      // Fail closed rather than write an attacker-shaped key.
      this.reportFailure(attempt.scope, 'invalid_scope');
      throw new RateLimitStoreUnavailableError();
    }
    const digest = createHash('sha256')
      .update(attempt.discriminator)
      .digest('hex');
    try {
      // The client bounds its own connect and each command, so the deadline here
      // covers the worst legitimate sequence of both rather than either alone. It
      // exists because a caller that cannot decide in bounded time is a hang, and a
      // hung upload keeps its whole request body in memory.
      const current = Number(
        await this.withDeadline(
          (async () => {
            await this.ensureConnected();
            return this.client.eval(
              fixedWindowRateLimitScript,
              1,
              `${this.configuration.redisKeyPrefix}:${attempt.scope}:${digest}`,
              String(attempt.windowSeconds),
            );
          })(),
          2 * this.configuration.connection.timeoutMs,
        ),
      );
      // A malformed reply denies as well: NaN fails the comparison below.
      return current <= attempt.max;
    } catch (error) {
      this.reportFailure(
        attempt.scope,
        error instanceof RateLimitDeadlineError ? 'timeout' : 'unavailable',
      );
      throw new RateLimitStoreUnavailableError(error);
    }
  }

  public onApplicationShutdown(): void {
    // Set before disconnecting: a request that reaches the limiter afterwards must
    // fail closed instead of opening a fresh socket that outlives the shutdown.
    this.closed = true;
    this.client.disconnect();
  }

  private reportFailure(scope: string, failureKind: string): void {
    this.logger.error({
      event: 'rate_limit_store_failure',
      scope,
      failureKind,
      errorCode: 'RATE_LIMIT_UNAVAILABLE',
    });
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RateLimitDeadlineError()),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new RateLimitStoreUnavailableError();
    if (this.client.status === 'ready') return;
    if (!this.connection) {
      this.connection = this.client.connect().finally(() => {
        this.connection = undefined;
      });
    }
    await this.connection;
  }
}

class RateLimitDeadlineError extends Error {
  public constructor() {
    super('Rate-limit storage did not answer within its bound');
    this.name = 'RateLimitDeadlineError';
  }
}
