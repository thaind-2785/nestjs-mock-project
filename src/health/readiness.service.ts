import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { HealthIndicatorService } from '@nestjs/terminus';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { DataSource } from 'typeorm';
import { readinessConfig } from '../config/readiness.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  READINESS_REDIS_FACTORY,
  READINESS_STORAGE_CLIENT,
} from './readiness.tokens';

export const readinessDependencies = ['mysql', 'redis', 'storage'] as const;
export type ReadinessDependency = (typeof readinessDependencies)[number];

export interface RedisReadinessClient {
  connect(): Promise<void>;
  disconnect(): void;
  ping(): Promise<string>;
}

export type RedisReadinessClientFactory = () => RedisReadinessClient;

export interface StorageReadinessClient {
  destroy(): void;
  send(
    command: ListBucketsCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

interface ReadinessProbeResult {
  dependency: ReadinessDependency;
  healthy: boolean;
}

@Injectable()
export class ReadinessService implements OnApplicationShutdown {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    @Inject(readinessConfig.KEY)
    private readonly configuration: ConfigType<typeof readinessConfig>,
    @Inject(READINESS_REDIS_FACTORY)
    private readonly createRedisClient: RedisReadinessClientFactory,
    @Inject(READINESS_STORAGE_CLIENT)
    private readonly storageClient: StorageReadinessClient,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async getUnavailableDependencies(): Promise<ReadinessDependency[]> {
    const results = await Promise.all([
      this.checkMySql(),
      this.checkRedis(),
      this.checkStorage(),
    ]);

    return results
      .filter((result) => !result.healthy)
      .map((result) => result.dependency);
  }

  onApplicationShutdown(): void {
    this.storageClient.destroy();
  }

  private async checkMySql(): Promise<ReadinessProbeResult> {
    try {
      await this.withTimeout(async () => {
        await this.databaseConnection.ensureInitialized();
        await this.dataSource.query('SELECT 1');
      });
      this.healthIndicator.check('mysql').up();
      return { dependency: 'mysql', healthy: true };
    } catch {
      this.healthIndicator.check('mysql').down();
      return { dependency: 'mysql', healthy: false };
    }
  }

  private async checkRedis(): Promise<ReadinessProbeResult> {
    const client = this.createRedisClient();
    try {
      const response = await this.withTimeout(async () => {
        await client.connect();
        return client.ping();
      });
      if (response !== 'PONG')
        throw new Error('Unexpected Redis readiness response');
      this.healthIndicator.check('redis').up();
      return { dependency: 'redis', healthy: true };
    } catch {
      this.healthIndicator.check('redis').down();
      return { dependency: 'redis', healthy: false };
    } finally {
      client.disconnect();
    }
  }

  private async checkStorage(): Promise<ReadinessProbeResult> {
    try {
      await this.withTimeout((abortSignal) =>
        this.storageClient.send(new ListBucketsCommand({}), { abortSignal }),
      );
      this.healthIndicator.check('storage').up();
      return { dependency: 'storage', healthy: true };
    } catch {
      this.healthIndicator.check('storage').down();
      return { dependency: 'storage', healthy: false };
    }
  }

  private async withTimeout<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(abortController.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abortController.abort();
            reject(new Error('Readiness check timed out'));
          }, this.configuration.timeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
