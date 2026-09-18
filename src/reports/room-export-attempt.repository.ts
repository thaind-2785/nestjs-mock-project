import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { StorageCleanupReason } from '../files/entities/attachment.enums';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { OutboxEventStatus } from '../common/outbox/outbox.enums';
import { ExportJobStatus } from './entities/export-job.enums';
import { roomExportEventType } from './room-export.constants';
import type {
  RoomExportAttemptClaim,
  RoomExportCompletion,
  RoomExportFailureRecord,
  RoomExportRetry,
} from './room-export-attempt.types';

/**
 * Every write an attempt makes to its own outbox event and job.
 *
 * One rule runs through all of it: the outbox row is locked first and the job second,
 * everywhere, and no statement touches either unless the caller still holds the claim
 * it started with. A worker whose lease expired mid-attempt therefore matches zero
 * rows and changes nothing, rather than finishing on top of whoever recovered it.
 *
 * The caller owns the `EntityManager` because these writes have to share a transaction
 * with the checks that justify them, and none of them may be open while a Worker
 * Thread or an object store is being waited on.
 */
@Injectable()
export class RoomExportAttemptRepository {
  /**
   * Confirms this job is still ours and marks it started.
   *
   * The outbox row is read `FOR UPDATE` before the job so the lock order matches every
   * other path. `lock_expires_at > NOW(6)` is part of the predicate rather than a check
   * afterwards: a lease that expired while this job sat in the queue belongs to whoever
   * recovers it next, and finding that out after doing the work is too late.
   */
  async claim(
    manager: EntityManager,
    input: { outboxEventId: string; claimToken: string; attempt: number },
  ): Promise<RoomExportAttemptClaim | null> {
    const events: Array<{ id: string; payload: { jobId?: string } }> =
      await manager.query(
        `SELECT id, payload FROM outbox_events
         WHERE id = ?
           AND event_type = ?
           AND status = ?
           AND locked_by = ?
           AND attempts = ?
           AND lock_expires_at > NOW(6)
         FOR UPDATE`,
        [
          input.outboxEventId,
          roomExportEventType,
          OutboxEventStatus.Processing,
          input.claimToken,
          input.attempt,
        ],
      );
    if (events.length === 0) return null;

    const jobId = events[0].payload.jobId;
    if (typeof jobId !== 'string') return null;

    const jobs: Array<{ id: string; filters: Record<string, unknown> }> =
      await manager.query(
        `SELECT id, filters FROM export_jobs
         WHERE id = ? AND outbox_event_id = ? AND status IN (?, ?)
         FOR UPDATE`,
        [
          jobId,
          input.outboxEventId,
          ExportJobStatus.Queued,
          ExportJobStatus.Processing,
        ],
      );
    if (jobs.length === 0) return null;

    await manager.query(
      `UPDATE export_jobs
       SET status = ?, started_at = COALESCE(started_at, NOW(6)), last_error_code = NULL
       WHERE id = ?`,
      [ExportJobStatus.Processing, jobId],
    );
    return { jobId, filters: jobs[0].filters };
  }

  /**
   * Extends the lease for the next bounded stage, and says whether it still existed.
   *
   * Called before generation and before the upload rather than once at the start, so
   * each stage runs under a full lease instead of whatever the previous one left. A
   * `false` here means the claim is gone and the attempt must stop before doing
   * anything another worker would have to undo.
   */
  async renew(
    manager: EntityManager,
    input: { outboxEventId: string; claimToken: string; leaseMs: number },
  ): Promise<boolean> {
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE outbox_events
       SET lock_expires_at = NOW(6) + INTERVAL ? MICROSECOND
       WHERE id = ?
         AND event_type = ?
         AND status = ?
         AND locked_by = ?
         AND lock_expires_at > NOW(6)`,
      [
        input.leaseMs * 1_000,
        input.outboxEventId,
        roomExportEventType,
        OutboxEventStatus.Processing,
        input.claimToken,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  /**
   * Records that an object is about to exist at a key nobody has committed to yet.
   *
   * Inserted before the upload and deleted only by the attempt that wins. A crash
   * between the two leaves a row whose due time has passed, and the existing cleanup
   * runner removes the object - which is the only thing standing between a crashed
   * upload and an orphan nobody can attribute.
   */
  async insertUploadSafeguard(
    manager: EntityManager,
    input: { objectKey: string; graceMs: number },
  ): Promise<void> {
    await manager.insert(StorageCleanupTask, {
      id: randomUUID(),
      objectKey: input.objectKey,
      reason: StorageCleanupReason.UploadSafeguard,
      availableAt: new Date(Date.now() + input.graceMs),
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      attempts: 0,
    });
  }

  /**
   * Publishes the result, and only for the attempt that still owns the claim.
   *
   * Outbox first, job second, safeguard last. If the claim moved on, the first
   * statement matches nothing and the object stays covered by its safeguard - the
   * uploaded bytes are simply never pointed at, which is the difference between a
   * wasted attempt and a wrong answer.
   */
  async complete(
    manager: EntityManager,
    input: RoomExportCompletion,
  ): Promise<boolean> {
    const held = await this.finishEvent(manager, input, {
      status: OutboxEventStatus.Processed,
      assignments: 'processed_at = NOW(6), last_error_code = NULL',
      parameters: [],
    });
    if (!held) return false;

    await manager.query(
      `UPDATE export_jobs
       SET status = ?,
           object_key = ?,
           row_count = ?,
           file_size_bytes = ?,
           content_sha256 = ?,
           completed_at = NOW(6),
           expires_at = NOW(6) + INTERVAL ? HOUR,
           failed_at = NULL,
           last_error_code = NULL
       WHERE id = ? AND status = ?`,
      [
        ExportJobStatus.Completed,
        input.objectKey,
        input.rowCount,
        input.fileSizeBytes,
        input.contentSha256,
        input.resultTtlHours,
        input.jobId,
        ExportJobStatus.Processing,
      ],
    );
    // Only this attempt's safeguard, addressed by the key only this attempt could have
    // generated. A blanket delete by job would remove a losing attempt's cover too.
    await manager.query(
      'DELETE FROM storage_cleanup_tasks WHERE object_key = ? AND reason = ?',
      [input.objectKey, StorageCleanupReason.UploadSafeguard],
    );
    return true;
  }

  /**
   * Hands the attempt back for a later one, with the wait computed by the database as
   * the statement runs. Time spent failing is not silently subtracted from the backoff.
   */
  async retry(
    manager: EntityManager,
    input: RoomExportRetry,
  ): Promise<boolean> {
    const held = await this.finishEvent(manager, input, {
      status: OutboxEventStatus.Pending,
      assignments:
        'available_at = NOW(6) + INTERVAL ? MICROSECOND, last_error_code = ?',
      parameters: [input.retryInMs * 1_000, input.errorCode],
    });
    if (!held) return false;
    await manager.query(
      `UPDATE export_jobs
       SET status = ?, last_error_code = ?
       WHERE id = ? AND status = ?`,
      [
        ExportJobStatus.Queued,
        input.errorCode,
        input.jobId,
        ExportJobStatus.Processing,
      ],
    );
    return true;
  }

  /** Terminal for both rows, atomically, with a stable code and no result metadata. */
  async fail(
    manager: EntityManager,
    input: RoomExportFailureRecord,
  ): Promise<boolean> {
    const held = await this.finishEvent(manager, input, {
      status: OutboxEventStatus.Failed,
      assignments: 'failed_at = NOW(6), last_error_code = ?',
      parameters: [input.errorCode],
    });
    if (!held) return false;
    await manager.query(
      `UPDATE export_jobs
       SET status = ?, failed_at = NOW(6), last_error_code = ?
       WHERE id = ? AND status = ?`,
      [
        ExportJobStatus.Failed,
        input.errorCode,
        input.jobId,
        ExportJobStatus.Processing,
      ],
    );
    return true;
  }

  private async finishEvent(
    manager: EntityManager,
    key: { outboxEventId: string; claimToken: string; attempt: number },
    outcome: {
      status: OutboxEventStatus;
      assignments: string;
      parameters: unknown[];
    },
  ): Promise<boolean> {
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE outbox_events
       SET status = ?,
           locked_at = NULL,
           lock_expires_at = NULL,
           locked_by = NULL,
           ${outcome.assignments}
       WHERE id = ?
         AND event_type = ?
         AND status = ?
         AND locked_by = ?
         AND attempts = ?`,
      [
        outcome.status,
        ...outcome.parameters,
        key.outboxEventId,
        roomExportEventType,
        OutboxEventStatus.Processing,
        key.claimToken,
        key.attempt,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }
}
