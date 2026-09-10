import { hostname } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { attachmentsConfig } from '../config/attachments.config';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';
import { AttachmentStorageService } from './storage/attachment-storage.service';

export const defaultCleanupBatchSize = 25;

export interface StorageCleanupOptions {
  batchSize?: number;
  workerId?: string;
}

export interface StorageCleanupResult {
  claimed: number;
  deleted: number;
  retryable: number;
}

/**
 * Drains `storage_cleanup_tasks`: upload safeguards whose metadata commit never
 * happened, and objects detached by a replacement or delete.
 *
 * The runner is deliberately dumb and restartable. It claims only work that is due
 * and unleased, takes an expiring lease so a crashed worker's rows return on their
 * own, and relies on object deletion being idempotent, so retrying a task that
 * already deleted its object still completes.
 */
@Injectable()
export class StorageCleanupService {
  private readonly logger = new Logger(StorageCleanupService.name);

  public constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    private readonly storage: AttachmentStorageService,
    @Inject(attachmentsConfig.KEY)
    private readonly configuration: ConfigType<typeof attachmentsConfig>,
  ) {}

  public async run(
    options: StorageCleanupOptions = {},
  ): Promise<StorageCleanupResult> {
    await this.databaseConnection.ensureInitialized();
    const workerId = (options.workerId ?? hostname()).slice(0, 100);
    const batchSize = options.batchSize ?? defaultCleanupBatchSize;
    const tasks: StorageCleanupTask[] = [];
    let deleted = 0;
    let retryable = 0;
    for (let index = 0; index < batchSize; index += 1) {
      // Claim one row immediately before its provider call. A batch-level lease
      // expires while later rows wait behind an earlier slow delete, allowing a
      // second worker to process the same row concurrently.
      const task = await this.claimOne(workerId);
      if (!task) break;
      tasks.push(task);
      try {
        await this.storage.deleteObject(task.objectKey);
        await this.dataSource.manager.delete(StorageCleanupTask, {
          id: task.id,
        });
        deleted += 1;
      } catch {
        // The task stays: it is the durable intent. Releasing the lease with a
        // delay keeps a failing provider from being hammered by the next run.
        await this.release(task.id);
        retryable += 1;
        this.logger.warn({
          event: 'storage_cleanup_retryable',
          taskId: task.id,
          reason: task.reason,
          attempts: task.attempts + 1,
          errorCode: 'STORAGE_UNAVAILABLE',
        });
      }
    }
    const result = { claimed: tasks.length, deleted, retryable };
    this.logger.log({ event: 'storage_cleanup_batch_completed', ...result });
    return result;
  }

  /**
   * Claims due work under `FOR UPDATE SKIP LOCKED`, so two workers never process
   * the same row and neither waits for the other.
   */
  private claimOne(workerId: string): Promise<StorageCleanupTask | null> {
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const candidate = await manager
        .getRepository(StorageCleanupTask)
        .createQueryBuilder('task')
        .select(['task.id', 'task.objectKey', 'task.reason', 'task.attempts'])
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        // Never before `available_at`: an upload safeguard is still protecting an
        // in-flight storage write until its grace period passes.
        .where('task.available_at <= :now', { now })
        .andWhere(
          '(task.lock_expires_at IS NULL OR task.lock_expires_at <= :now)',
          { now },
        )
        .orderBy('task.available_at', 'ASC')
        .addOrderBy('task.id', 'ASC')
        .getOne();
      if (!candidate) return null;

      // The lease outlives the bounded storage call by construction: configuration
      // rejects a cleanup grace that is not greater than the storage timeout.
      await manager.update(
        StorageCleanupTask,
        { id: candidate.id },
        {
          lockedAt: now,
          lockExpiresAt: new Date(
            now.getTime() + this.configuration.cleanupGraceMs,
          ),
          lockedBy: workerId,
          attempts: () => 'attempts + 1',
        },
      );
      return candidate;
    });
  }

  private async release(taskId: string): Promise<void> {
    const now = Date.now();
    await this.dataSource.manager.update(
      StorageCleanupTask,
      { id: taskId },
      {
        lockedAt: null,
        lockExpiresAt: null,
        lockedBy: null,
        availableAt: new Date(now + this.configuration.cleanupGraceMs),
      },
    );
  }
}
