import type { HeadBucketCommand } from '@aws-sdk/client-s3';
import type { readinessDependencies } from './readiness.constants';

export type ReadinessDependency = (typeof readinessDependencies)[number];

export interface RedisReadinessClient {
  connect(): Promise<void>;
  disconnect(): void;
  ping(): Promise<string>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
  ): Promise<unknown>;
}

export type RedisReadinessClientFactory = () => RedisReadinessClient;

export interface StorageReadinessClient {
  destroy(): void;
  send(
    command: HeadBucketCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface ReadinessProbeResult {
  dependency: ReadinessDependency;
  healthy: boolean;
}
