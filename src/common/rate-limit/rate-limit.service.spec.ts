import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import {
  RateLimitService,
  RateLimitStoreUnavailableError,
} from './rate-limit.service';

describe('RateLimitService', () => {
  function createFixture(current: number | Error) {
    const evaluate =
      current instanceof Error
        ? jest.fn().mockRejectedValue(current)
        : jest.fn().mockResolvedValue(current);
    const client = {
      status: 'ready',
      connect: jest.fn(),
      disconnect: jest.fn(),
      eval: evaluate,
    } as unknown as Redis;
    const service = new RateLimitService(client, {
      redisKeyPrefix: 'hotel:test-rate',
      connection: { host: '127.0.0.1', port: 6379, timeoutMs: 50 },
    });
    return { evaluate, service };
  }

  it('allows attempts through the configured maximum and hashes the discriminator', async () => {
    const { evaluate, service } = createFixture(3);

    await expect(
      service.consume({
        scope: 'attachment-upload',
        discriminator: 'admin-user-id',
        max: 3,
        windowSeconds: 60,
      }),
    ).resolves.toBe(true);

    const digest = createHash('sha256').update('admin-user-id').digest('hex');
    expect(evaluate).toHaveBeenCalledWith(
      expect.any(String),
      1,
      `hotel:test-rate:attachment-upload:${digest}`,
      '60',
    );
    expect(JSON.stringify(evaluate.mock.calls)).not.toContain('admin-user-id');
  });

  it('denies the first attempt above the maximum', async () => {
    const { service } = createFixture(4);

    await expect(
      service.consume({
        scope: 'attachment-upload',
        discriminator: 'admin-user-id',
        max: 3,
        windowSeconds: 60,
      }),
    ).resolves.toBe(false);
  });

  it('fails closed when the store accepts the command but never answers', async () => {
    const client = {
      status: 'ready',
      connect: jest.fn(),
      disconnect: jest.fn(),
      // A reachable but stalled server: the socket is healthy, the reply never
      // arrives. Without a deadline the caller would hang instead of deciding, and
      // an upload would hold its buffered body for as long as the stall lasts.
      eval: jest.fn().mockReturnValue(new Promise(() => undefined)),
    } as unknown as Redis;
    const service = new RateLimitService(client, {
      redisKeyPrefix: 'hotel:test-rate',
      connection: { host: '127.0.0.1', port: 6379, timeoutMs: 25 },
    });

    await expect(
      service.consume({
        scope: 'attachment-upload',
        discriminator: 'admin-user-id',
        max: 3,
        windowSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });

  it('refuses a scope that could forge or cross a namespace', async () => {
    const { evaluate, service } = createFixture(1);

    await expect(
      service.consume({
        scope: 'attachment-upload:hotel:auth',
        discriminator: 'admin-user-id',
        max: 3,
        windowSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('refuses to reopen a connection once shutdown has begun', async () => {
    const { evaluate, service } = createFixture(1);

    service.onApplicationShutdown();

    await expect(
      service.consume({
        scope: 'attachment-upload',
        discriminator: 'admin-user-id',
        max: 3,
        windowSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails closed with a provider-neutral error when Redis is unavailable', async () => {
    const { service } = createFixture(new Error('private Redis endpoint'));

    await expect(
      service.consume({
        scope: 'auth-refresh',
        discriminator: 'client-address',
        max: 20,
        windowSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });
});
