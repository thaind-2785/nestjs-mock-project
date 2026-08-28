/* eslint-disable @typescript-eslint/unbound-method */
import { HealthIndicatorService } from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { ReadinessConfiguration } from '../config/readiness.config';
import {
  ReadinessService,
  RedisReadinessClient,
  StorageReadinessClient,
} from './readiness.service';

const configuration: ReadinessConfiguration = {
  timeoutMs: 25,
  redis: { host: '127.0.0.1', port: 6379 },
  storage: {
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'hotel-assets',
    accessKey: 'hotel_local',
    secretKey: 'local_minio_change_me',
  },
};

function createService({
  dataSource = {
    isInitialized: false,
    initialize: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
  },
  redis = {
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    disconnect: jest.fn(),
  },
  storage = {
    send: jest.fn().mockResolvedValue({}),
    destroy: jest.fn(),
  },
  timeoutMs = configuration.timeoutMs,
}: {
  dataSource?: Partial<DataSource>;
  redis?: RedisReadinessClient;
  storage?: StorageReadinessClient;
  timeoutMs?: number;
} = {}) {
  const source = dataSource as DataSource;
  const redisClient = redis;
  const storageClient = storage;
  const service = new ReadinessService(
    source,
    { ...configuration, timeoutMs },
    () => redisClient,
    storageClient,
    new HealthIndicatorService(),
  );

  return { service, source, redisClient, storageClient };
}

describe('ReadinessService', () => {
  it('checks all required dependencies concurrently and lazily initializes MySQL', async () => {
    const { service, source, redisClient, storageClient } = createService();

    await expect(service.getUnavailableDependencies()).resolves.toEqual([]);
    expect(jest.mocked(source.initialize)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(source.query)).toHaveBeenCalledWith('SELECT 1');
    expect(jest.mocked(redisClient.connect)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(redisClient.ping)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(redisClient.disconnect)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(storageClient.send)).toHaveBeenCalledTimes(1);
  });

  it('returns only sanitized dependency classes for failures', async () => {
    const { service } = createService({
      dataSource: {
        isInitialized: true,
        query: jest
          .fn()
          .mockRejectedValue(new Error('mysql://user:secret@host')),
      },
      redis: {
        connect: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue('NOPE'),
        disconnect: jest.fn(),
      },
      storage: {
        send: jest.fn().mockRejectedValue(new Error('accessKey=secret')),
        destroy: jest.fn(),
      },
    });

    await expect(service.getUnavailableDependencies()).resolves.toEqual([
      'mysql',
      'redis',
      'storage',
    ]);
  });

  it('bounds a slow dependency and releases transient Redis clients', async () => {
    const redis: RedisReadinessClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('PONG'), 50),
          ),
      ),
      disconnect: jest.fn(),
    };
    const { service } = createService({ redis, timeoutMs: 10 });

    await expect(service.getUnavailableDependencies()).resolves.toEqual([
      'redis',
    ]);
    expect(jest.mocked(redis.disconnect)).toHaveBeenCalledTimes(1);
  });

  it('aborts a slow storage request when its readiness timeout expires', async () => {
    let aborted = false;
    const { service } = createService({
      storage: {
        destroy: jest.fn(),
        send: jest.fn(
          (_command, options) =>
            new Promise((_, reject) => {
              options?.abortSignal?.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
              });
            }),
        ),
      },
      timeoutMs: 10,
    });

    await expect(service.getUnavailableDependencies()).resolves.toEqual([
      'storage',
    ]);
    expect(aborted).toBe(true);
  });

  it('destroys the storage client on application shutdown', () => {
    const { service, storageClient } = createService();

    service.onApplicationShutdown();
    expect(jest.mocked(storageClient.destroy)).toHaveBeenCalledTimes(1);
  });
});
