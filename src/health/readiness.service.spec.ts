/* eslint-disable @typescript-eslint/unbound-method */
import { HealthIndicatorService } from '@nestjs/terminus';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { DataSource } from 'typeorm';
import { ReadinessConfiguration } from '../config/readiness.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  ReadinessService,
  RedisReadinessClient,
  StorageReadinessClient,
} from './readiness.service';

const configuration: ReadinessConfiguration = {
  timeoutMs: 25,
  redis: { host: '127.0.0.1', port: 6379 },
  rateLimitKeyPrefix: 'hotel:test-rate',
  storage: {
    endpoint: 'http://127.0.0.1:9000',
    region: 'us-east-1',
    forcePathStyle: true,
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
    set: jest.fn().mockResolvedValue('OK'),
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
    new DatabaseConnectionService(source),
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
    const [command] = jest.mocked(storageClient.send).mock.calls[0];
    expect(command).toBeInstanceOf(HeadBucketCommand);
    expect(command.input.Bucket).toBe('hotel-assets');
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
        set: jest.fn().mockResolvedValue('OK'),
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

  it('reports Redis unready when it answers PING but refuses the write', async () => {
    const redis: RedisReadinessClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      ping: jest.fn().mockResolvedValue('PONG'),
      set: jest
        .fn()
        .mockRejectedValue(
          new Error("OOM command not allowed when used memory > 'maxmemory'"),
        ),
      disconnect: jest.fn(),
    };
    const { service } = createService({ redis });

    await expect(service.getUnavailableDependencies()).resolves.toEqual([
      'redis',
    ]);
    expect(jest.mocked(redis.set)).toHaveBeenCalledWith(
      'hotel:test-rate:readiness',
      '1',
      'EX',
      30,
    );
    expect(jest.mocked(redis.disconnect)).toHaveBeenCalledTimes(1);
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
      set: jest.fn().mockResolvedValue('OK'),
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
