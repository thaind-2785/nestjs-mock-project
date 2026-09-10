import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { RateLimitService } from '../../src/common/rate-limit/rate-limit.service';
import { createRedisConnectionConfiguration } from '../../src/config/redis.config';
import { createObjectStorageClientOptions } from '../../src/common/storage/object-storage-client';
import {
  AttachmentsConfiguration,
  createAttachmentsConfiguration,
} from '../../src/config/attachments.config';
import type { EnvironmentVariables } from '../../src/config/environment.validation';
import { createObjectStorageConfiguration } from '../../src/config/object-storage.config';
import type { DatabaseConnectionService } from '../../src/database/database-connection.service';
import { AttachmentPolicyRegistry } from '../../src/files/attachment-policy';
import { AttachmentsService } from '../../src/files/attachments.service';
import { StorageCleanupService } from '../../src/files/storage-cleanup.service';
import { AttachmentStorageService } from '../../src/files/storage/attachment-storage.service';
import { RoomImagesService } from '../../src/rooms/room-images.service';

/**
 * The private bucket is provisioned outside the application in managed
 * environments; local suites create it on demand so a fresh volume is enough.
 */
export async function ensureAttachmentBucket(
  environment: EnvironmentVariables,
): Promise<void> {
  const storage = createObjectStorageConfiguration(environment);
  const client = new S3Client(createObjectStorageClientOptions(storage));
  try {
    await client.send(new HeadBucketCommand({ Bucket: storage.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: storage.bucket }));
  } finally {
    client.destroy();
  }
}

export interface RoomImageFixture {
  images: RoomImagesService;
  attachments: AttachmentsService;
  storage: AttachmentStorageService;
  cleanup: StorageCleanupService;
  policies: AttachmentPolicyRegistry;
  rateLimit: RateLimitService;
  configuration: AttachmentsConfiguration;
  bucket: string;
  ensureBucket: () => Promise<void>;
  destroy: () => void;
}

/**
 * Builds the real attachment stack against local MinIO. Integration suites use it so
 * a room response goes through the same storage adapter, policy registry, and
 * cleanup runner that production wires through Nest.
 */
export function createRoomImageFixture(
  dataSource: DataSource,
  connection: DatabaseConnectionService,
  environment: EnvironmentVariables,
  overrides: Partial<AttachmentsConfiguration> = {},
  // A closed port proves the fail-closed upload path against a real client rather
  // than a rejecting stub.
  rateLimitRedisPort: number = environment.REDIS_PORT,
): RoomImageFixture {
  const storageConfiguration = createObjectStorageConfiguration(environment);
  const configuration: AttachmentsConfiguration = {
    ...createAttachmentsConfiguration(environment),
    ...overrides,
  };
  const client = new S3Client(
    createObjectStorageClientOptions(storageConfiguration),
  );
  const storage = new AttachmentStorageService(
    client,
    storageConfiguration,
    configuration,
  );
  // Every fixture owns its own limiter namespace, so a suite never spends or
  // observes another suite's upload budget.
  const redisClient = new Redis({
    host: environment.REDIS_HOST,
    port: rateLimitRedisPort,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    retryStrategy: () => null,
  });
  const rateLimit = new RateLimitService(redisClient, {
    redisKeyPrefix: `hotel:test-rate:${process.pid}:${randomUUID().replaceAll('-', '')}`,
    connection: {
      ...createRedisConnectionConfiguration(environment),
      port: rateLimitRedisPort,
    },
  });
  const attachments = new AttachmentsService(
    dataSource,
    storage,
    rateLimit,
    configuration,
  );
  const policies = new AttachmentPolicyRegistry(configuration);

  return {
    images: new RoomImagesService(
      dataSource,
      connection,
      policies,
      attachments,
    ),
    attachments,
    storage,
    cleanup: new StorageCleanupService(
      dataSource,
      connection,
      storage,
      configuration,
    ),
    policies,
    rateLimit,
    configuration,
    bucket: storageConfiguration.bucket,
    ensureBucket: () => ensureAttachmentBucket(environment),
    destroy: () => {
      client.destroy();
      redisClient.disconnect();
    },
  };
}
