import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { reportsConfig } from '../config/reports.config';
import { retentionConfig } from '../config/retention.config';
import { StorageCleanupService } from '../files/storage-cleanup.service';
import { ObjectStorageProvider } from '../common/storage/object-storage.provider';
import { retentionDuePredicate } from './retention-due';
import { RetentionDeleteRepository } from './retention-delete.repository';
import {
  retentionErrorCodes,
  storageDrainBatchSize,
  type RetentionTaskName,
} from './retention.constants';
import type { RetentionBatchOutcome } from './retention.types';

/**
 * One bounded pass of each task.
 *
 * Every method here returns what it deleted and whether more is waiting, and none of
 * them decides when to stop - that belongs to the run, which owns the budget. A task
 * that cannot finish its batch says so; it never throws away work it has already done.
 */
@Injectable()
export class RetentionTasksService {
  private readonly logger = new Logger(RetentionTasksService.name);

  constructor(
    private readonly deletes: RetentionDeleteRepository,
    private readonly storage: ObjectStorageProvider,
    private readonly storageCleanup: StorageCleanupService,
    @Inject(retentionConfig.KEY)
    private readonly configuration: ConfigType<typeof retentionConfig>,
    @Inject(reportsConfig.KEY)
    private readonly reports: ConfigType<typeof reportsConfig>,
  ) {}

  /**
   * `deadline` is passed in rather than owned here because a batch can be long.
   *
   * The run's budget used to be checked only between batches, which was sound while a
   * batch was one statement and wrong as soon as one became hundreds of provider calls:
   * a single export batch against a degraded object store could outlive the lease
   * entirely, and a second replica would recover a window this one was still deleting
   * inside. The loops below stop at the deadline and report what they did.
   */
  async runBatch(
    dataSource: DataSource,
    taskName: RetentionTaskName,
    batchSize: number,
    deadline: number,
  ): Promise<RetentionBatchOutcome> {
    switch (taskName) {
      case 'auth-sessions':
      case 'idempotency-keys':
        return this.purge(dataSource, taskName, batchSize);
      case 'storage-tasks':
        return this.drainStorageTasks();
      case 'notification-events':
        return this.collectNotificationEvents(dataSource, batchSize);
      case 'export-results':
        return this.collectExportResults(dataSource, batchSize, deadline);
    }
  }

  /**
   * A table with no dependents: one statement, and the count is the whole answer.
   *
   * `deleted === batchSize` is how the run learns there may be more. Asking the due
   * query again instead would cost a second scan to learn what the delete already knew.
   */
  private async purge(
    dataSource: DataSource,
    taskName: RetentionTaskName,
    batchSize: number,
  ): Promise<RetentionBatchOutcome> {
    const predicate = retentionDuePredicate(taskName);
    const deleted = await this.deletes.deleteBatch(
      dataSource.manager,
      predicate,
      this.configuration.windows,
      batchSize,
    );
    return {
      counts: deleted > 0 ? { [predicate.table]: deleted } : {},
      moreWaiting: deleted === batchSize,
    };
  }

  /**
   * Phase 3's service, scheduled rather than reimplemented.
   *
   * It owns the object deletion, the retry accounting and the lease on each task row,
   * and a second implementation here would be a second opinion about which of those
   * rows is safe to remove.
   */
  private async drainStorageTasks(): Promise<RetentionBatchOutcome> {
    // Its own bound, not `batchSize`. That number means rows one statement may delete,
    // and this service uses its argument as a loop counter over sequential provider
    // calls - handing it five hundred turns one batch into five hundred round trips.
    const result = await this.storageCleanup.run({
      batchSize: storageDrainBatchSize,
    });
    return {
      counts:
        result.deleted > 0 ? { storage_cleanup_tasks: result.deleted } : {},
      moreWaiting: result.claimed === storageDrainBatchSize,
      // A provider that refused is not a task that failed: the row stays due and the
      // next run tries again, which is the contract Phase 3 already established.
      retryableFailures: result.retryable,
    };
  }

  /**
   * Attempts, then deliveries, then the event.
   *
   * The middle step is protected by `ON DELETE RESTRICT`, so getting it wrong is a
   * rejected statement. The first is not protected by anything: `email_send_attempts`
   * carries no foreign key, deliberately, because an FK insert would take a shared lock
   * on the row a recovering worker may hold exclusively - so deleting the event first
   * succeeds and silently orphans the attempts. Nothing would ever report it.
   */
  private async collectNotificationEvents(
    dataSource: DataSource,
    batchSize: number,
  ): Promise<RetentionBatchOutcome> {
    const predicate = retentionDuePredicate('notification-events');
    const batch = await this.deletes.claimEventBatch(
      dataSource.manager,
      predicate,
      this.configuration.windows,
      batchSize,
      this.configuration.run.statementTimeoutMs,
    );
    if (batch.eventIds.length === 0) return { counts: {}, moreWaiting: false };

    // One transaction per batch: the three steps are a unit, and a crash between them
    // would leave children whose parent is gone with nothing to find them by.
    const counts = await dataSource.transaction(async (manager) => {
      const attempts = await this.deletes.deleteSendAttempts(
        manager,
        batch.eventIds,
      );
      const deliveries = await this.deletes.deleteDeliveries(
        manager,
        batch.eventIds,
      );
      const events = await this.deletes.deleteEvents(manager, batch.eventIds);
      return {
        email_send_attempts: attempts,
        email_deliveries: deliveries,
        outbox_events: events,
      };
    });

    return {
      counts: Object.fromEntries(
        Object.entries(counts).filter(([, value]) => value > 0),
      ),
      moreWaiting: batch.eventIds.length === batchSize,
    };
  }

  /**
   * The object, then the job, then the event.
   *
   * The object goes first because it is the only part that is not transactional: an
   * object deleted with its rows intact is retried harmlessly next run, while rows
   * deleted with the object intact leave a file nothing can ever name again.
   *
   * A provider that refuses does not fail the task. That job keeps its rows and stays
   * due; the rest of the batch proceeds.
   */
  private async collectExportResults(
    dataSource: DataSource,
    batchSize: number,
    deadline: number,
  ): Promise<RetentionBatchOutcome> {
    const predicate = retentionDuePredicate('export-results');
    const batch = await this.deletes.claimExportBatch(
      dataSource.manager,
      predicate,
      this.configuration.windows,
      batchSize,
      this.configuration.run.statementTimeoutMs,
    );
    if (batch.jobs.length === 0) return { counts: {}, moreWaiting: false };

    const removable: typeof batch.jobs = [];
    let objectsDeleted = 0;
    let retryableFailures = 0;

    let truncated = false;

    for (const job of batch.jobs) {
      // Checked inside the loop, not only between batches: each iteration is a bounded
      // provider call, and five hundred of them against a slow store is how a batch
      // outlives the lease it was supposed to fit inside.
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      if (job.objectKey === null) {
        // A failed job never uploaded anything. Its rows are still due.
        removable.push(job);
        continue;
      }
      // No check that another job shares this key. `stagingObjectKey` puts the job's own
      // UUID in the path and `uq_export_jobs_outbox_event` gives one job per event, so
      // two rows cannot share one - the query that used to ask could only ever answer
      // zero, at the cost of one round trip per job inside the batch whose duration the
      // lease depends on. If that key scheme ever changes, this is the comment to find.
      try {
        await this.storage.deleteObject({
          objectKey: job.objectKey,
          timeoutMs: this.reports.storage.timeoutMs,
        });
        objectsDeleted += 1;
        removable.push(job);
      } catch (error) {
        retryableFailures += 1;
        this.logger.warn({
          event: 'retention_object_delete_failed',
          jobId: job.id,
          errorCode: retentionErrorCodes.storageUnavailable,
          reason: error instanceof Error ? error.name : 'UNKNOWN',
        });
      }
    }

    if (removable.length === 0) {
      // Nothing removable and every attempt refused is a total outage of the dependency
      // this task exists to call. It must not read as a quiet night.
      return {
        counts: {},
        moreWaiting: truncated || retryableFailures > 0,
        retryableFailures,
      };
    }

    const counts = await dataSource.transaction(async (manager) => {
      const jobs = await this.deletes.deleteExportJobs(
        manager,
        removable.map((job) => job.id),
      );
      const events = await this.deletes.deleteEvents(
        manager,
        removable.map((job) => job.outboxEventId),
      );
      return { export_jobs: jobs, outbox_events: events };
    });

    return {
      counts: {
        ...(objectsDeleted > 0 ? { export_objects: objectsDeleted } : {}),
        ...Object.fromEntries(
          Object.entries(counts).filter(([, value]) => value > 0),
        ),
      },
      moreWaiting: truncated || batch.jobs.length === batchSize,
      retryableFailures,
    };
  }
}
