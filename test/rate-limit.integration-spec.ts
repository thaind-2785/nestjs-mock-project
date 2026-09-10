import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  RateLimitService,
  RateLimitStoreUnavailableError,
} from '../src/common/rate-limit/rate-limit.service';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createRedisConnectionConfiguration } from '../src/config/redis.config';

jest.setTimeout(30_000);

/**
 * The counter itself, against real Redis. The unit suite stubs `eval`, so it can
 * prove the decision but not the Lua script: without these cases, deleting the
 * `EXPIRE` call would keep every suite green while locking every uploader and login
 * address out permanently in production.
 */
describe('Shared rate limiter against real Redis', () => {
  let inspector: Redis;
  let environment: ReturnType<typeof validateEnvironment>;
  let keyPrefix: string;
  let service: RateLimitService;
  let client: Redis;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    environment = validateEnvironment(process.env);
    inspector = new Redis({
      host: environment.REDIS_HOST,
      port: environment.REDIS_PORT,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      await inspector.connect();
    } catch (error) {
      throw new Error(
        `Redis rate-limit integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  beforeEach(() => {
    keyPrefix = `hotel:test-rate:${process.pid}:${randomUUID().replaceAll('-', '')}`;
    client = createClient(environment.REDIS_PORT);
    service = createService(client, keyPrefix);
  });

  afterEach(() => {
    client.disconnect();
  });

  afterAll(async () => {
    try {
      // Only the keys this suite created, so a shared local Redis keeps its data.
      const keys = await inspector.keys(`hotel:test-rate:${process.pid}:*`);
      if (keys.length) await inspector.del(...keys);
    } finally {
      inspector.disconnect();
    }
  });

  function createClient(port: number): Redis {
    return new Redis({
      host: environment.REDIS_HOST,
      port,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      retryStrategy: () => null,
    });
  }

  function createService(redis: Redis, prefix: string): RateLimitService {
    return new RateLimitService(redis, {
      redisKeyPrefix: prefix,
      connection: createRedisConnectionConfiguration(environment),
    });
  }

  function attempt(scope: string, windowSeconds = 60, max = 2) {
    return service.consume({
      scope,
      discriminator: 'uploader-under-test',
      max,
      windowSeconds,
    });
  }

  async function counterKeys(prefix: string): Promise<string[]> {
    return inspector.keys(`${prefix}:*`);
  }

  it('admits exactly the maximum inside one window', async () => {
    await expect(attempt('attachment-upload')).resolves.toBe(true);
    await expect(attempt('attachment-upload')).resolves.toBe(true);
    await expect(attempt('attachment-upload')).resolves.toBe(false);
  });

  it('expires the window and does not extend it while a client keeps trying', async () => {
    await expect(attempt('attachment-upload', 2)).resolves.toBe(true);
    const [key] = await counterKeys(keyPrefix);
    expect(key).toBeDefined();
    const initialTtl = await inspector.pttl(key);
    // A TTL must exist at all: an unexpiring counter is a permanent lockout.
    expect(initialTtl).toBeGreaterThan(0);
    expect(initialTtl).toBeLessThanOrEqual(2_000);

    await expect(attempt('attachment-upload', 2)).resolves.toBe(true);
    await expect(attempt('attachment-upload', 2)).resolves.toBe(false);
    // Hammering must not push the expiry out, or a refused client could extend its
    // own lockout indefinitely.
    expect(await inspector.pttl(key)).toBeLessThanOrEqual(initialTtl);

    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(await inspector.exists(key)).toBe(0);
    await expect(attempt('attachment-upload', 2)).resolves.toBe(true);
  });

  it('keeps each scope on its own budget', async () => {
    await expect(attempt('auth-google-start', 60, 1)).resolves.toBe(true);
    await expect(attempt('auth-google-start', 60, 1)).resolves.toBe(false);
    // The limiter is shared; the budgets are not.
    await expect(attempt('auth-refresh', 60, 1)).resolves.toBe(true);
    await expect(attempt('attachment-upload', 60, 1)).resolves.toBe(true);
  });

  it('fails closed when the store is unreachable', async () => {
    const unreachable = createClient(63_999);
    const closedService = createService(unreachable, keyPrefix);
    try {
      await expect(
        closedService.consume({
          scope: 'attachment-upload',
          discriminator: 'uploader-under-test',
          max: 5,
          windowSeconds: 60,
        }),
      ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    } finally {
      unreachable.disconnect();
    }
  });
});
