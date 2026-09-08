import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { attachmentsConfig } from '../config/attachments.config';
import { AttachmentPolicy } from './attachment-policy';
import { verifyAttachmentContent } from './attachment-signature';
import {
  AttachmentTarget,
  deleteUploadSafeguard,
  findTargetAttachment,
  findTargetAttachments,
  insertAttachment,
  insertUploadSafeguard,
  lockUploadSafeguard,
  rewriteAttachmentPositions,
  scheduleDetachedCleanup,
} from './attachment-metadata';
import { Attachment } from './entities/attachment.entity';
import { StorageCleanupReason } from './entities/attachment.enums';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';
import { filesErrors } from './files.errors';
import { buildAttachmentObjectKey } from './storage/attachment-object-key';
import { AttachmentStorageService } from './storage/attachment-storage.service';

export interface StagedUpload {
  policy: AttachmentPolicy;
  objectId: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttachmentCommit {
  attachment: Attachment;
  /** Objects the commit detached. Deleting them is best-effort after commit. */
  detachedObjectKeys: string[];
}

export interface AttachmentRead {
  id: string;
  associationType: string;
  position: number;
  mimeType: string;
  sizeBytes: number;
  url: string;
  expiresAt: string;
}

/**
 * Target-agnostic attachment mechanics. The owning module locks and revalidates its
 * own target and calls these inside that transaction, which keeps the polymorphic
 * `object_type` registry here and the target lock where the target lives.
 */
@Injectable()
export class AttachmentsService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly storage: AttachmentStorageService,
    private readonly rateLimit: RateLimitService,
    @Inject(attachmentsConfig.KEY)
    private readonly configuration: ConfigType<typeof attachmentsConfig>,
  ) {}

  /**
   * The per-uploader upload budget, which is attachment infrastructure rather than a
   * per-target product rule: one storage adapter and one bucket serve every target,
   * so the cost of a flood is shared too. The owning module calls this before it
   * touches its target, so a rejected attempt costs one Redis counter and never a
   * signature check, a generated key, a safeguard row, or a provider round trip.
   */
  public async assertUploadAllowed(uploaderUserId: string): Promise<void> {
    let allowed: boolean;
    try {
      allowed = await this.rateLimit.consume({
        scope: 'attachment-upload',
        discriminator: uploaderUserId,
        max: this.configuration.uploadRateLimit.max,
        windowSeconds: this.configuration.uploadRateLimit.windowSeconds,
      });
    } catch {
      throw filesErrors.attachmentUploadUnavailable();
    }
    if (!allowed) throw filesErrors.attachmentUploadRateLimited();
  }

  /**
   * Everything that must happen before the target lock, in this order: verify the
   * bytes, generate the key, commit a durable cleanup safeguard for it, then write
   * the object. The upload therefore never runs inside a database transaction, and a
   * crash at any point after the safeguard commit leaves claimable cleanup work
   * instead of an unreferenced object.
   */
  public async stageUpload(input: {
    policy: AttachmentPolicy;
    objectId: string;
    declaredMimeType: string;
    body: Buffer;
  }): Promise<StagedUpload> {
    const mimeType = verifyAttachmentContent({
      policy: input.policy,
      declaredMimeType: input.declaredMimeType,
      body: input.body,
    });
    const objectKey = buildAttachmentObjectKey({
      policy: input.policy,
      objectId: input.objectId,
      mimeType,
    });

    await this.dataSource.transaction((manager) =>
      insertUploadSafeguard(
        manager,
        objectKey,
        new Date(Date.now() + this.configuration.cleanupGraceMs),
      ),
    );
    await this.storage.putObject({
      objectKey,
      body: input.body,
      contentType: mimeType,
    });

    return {
      policy: input.policy,
      objectId: input.objectId,
      objectKey,
      mimeType,
      sizeBytes: input.body.byteLength,
    };
  }

  /**
   * Runs inside the caller's target-locked transaction: the count limit, the
   * singleton replacement, the metadata insert, and retiring the safeguard commit
   * together or not at all.
   */
  public async completeUpload(
    manager: EntityManager,
    staged: StagedUpload,
    uploaderUserId: string,
  ): Promise<AttachmentCommit> {
    // Claim the safeguard row before making any metadata live. A cleanup worker
    // that already owns the row wins and this transaction must roll back; otherwise
    // the worker could delete the object between the upload and this insert.
    const safeguard = await lockUploadSafeguard(manager, staged.objectKey);
    if (!safeguard || safeguard.lockExpiresAt !== null) {
      throw filesErrors.storageUnavailable(
        new Error('Upload safeguard is no longer available'),
      );
    }

    const target = this.targetOf(staged);
    const existing = await findTargetAttachments(manager, target);

    // A singleton association is replaced rather than rejected; a multi-item one is
    // bounded by its configured count.
    const detachedObjectKeys: string[] = [];
    if (staged.policy.maxCount === 1) {
      for (const attachment of existing) {
        await manager.delete(Attachment, { id: attachment.id });
        detachedObjectKeys.push(attachment.objectKey);
      }
    } else if (existing.length >= staged.policy.maxCount) {
      throw filesErrors.attachmentLimitExceeded();
    }

    const attachment = await insertAttachment(manager, {
      ...target,
      uploaderUserId,
      // Positions stay contiguous and zero-based, so the next one is the count of
      // the rows that survive this commit.
      position: staged.policy.maxCount === 1 ? 0 : existing.length,
      objectKey: staged.objectKey,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
    });
    await scheduleDetachedCleanup(manager, detachedObjectKeys);
    await deleteUploadSafeguard(manager, staged.objectKey);

    return { attachment, detachedObjectKeys };
  }

  /**
   * Detaches one attachment matched by ID plus the full target tuple, keeps the
   * remaining positions contiguous, and queues the object for deletion in the same
   * transaction.
   */
  public async detach(
    manager: EntityManager,
    attachmentId: string,
    target: Pick<AttachmentTarget, 'objectType' | 'objectId'>,
  ): Promise<string> {
    const attachment = await findTargetAttachment(
      manager,
      attachmentId,
      target,
    );
    if (!attachment) throw filesErrors.attachmentNotFound();

    await manager.delete(Attachment, { id: attachment.id });
    const remaining = await findTargetAttachments(manager, {
      ...target,
      associationType: attachment.associationType,
    });
    await rewriteAttachmentPositions(
      manager,
      { ...target, associationType: attachment.associationType },
      remaining.map(({ id }) => id),
    );
    await scheduleDetachedCleanup(manager, [attachment.objectKey]);
    return attachment.objectKey;
  }

  /**
   * Accepts the complete current set exactly once. A partial list would imply an
   * order for rows it does not mention, so it is rejected instead of guessed.
   */
  public async reorder(
    manager: EntityManager,
    target: AttachmentTarget,
    attachmentIds: readonly string[],
  ): Promise<Attachment[]> {
    const current = await findTargetAttachments(manager, target);
    const requested = new Set(attachmentIds);
    if (
      requested.size !== attachmentIds.length ||
      requested.size !== current.length ||
      current.some(({ id }) => !requested.has(id))
    ) {
      throw filesErrors.attachmentOrderInvalid();
    }

    await rewriteAttachmentPositions(manager, target, attachmentIds);
    return findTargetAttachments(manager, target);
  }

  /**
   * Best-effort object deletion after the commit that detached it. A failure here is
   * not an error for the caller: the durable cleanup task is already committed, so
   * the runner retries it. A success retires that task, which keeps the queue to
   * work that still has something to do.
   */
  public async deleteDetachedObjects(
    objectKeys: readonly string[],
  ): Promise<void> {
    for (const objectKey of objectKeys) {
      const deleted = await this.storage
        .deleteObject(objectKey)
        .then(() => true)
        .catch(() => false);
      if (!deleted) continue;
      await this.dataSource.manager
        .delete(StorageCleanupTask, {
          objectKey,
          reason: StorageCleanupReason.DetachedObject,
        })
        .catch(() => undefined);
    }
  }

  /** Presigned, short-lived reads. Object keys never leave the service layer. */
  public async createReads(
    attachments: readonly Attachment[],
  ): Promise<AttachmentRead[]> {
    const expiresAt = new Date(
      Date.now() + this.configuration.presignTtlSeconds * 1_000,
    ).toISOString();
    return Promise.all(
      attachments.map(async (attachment) => ({
        id: attachment.id,
        associationType: attachment.associationType,
        position: attachment.position,
        mimeType: attachment.mimeType,
        sizeBytes: Number(attachment.sizeBytes),
        url: await this.storage.createPresignedGetUrl(attachment.objectKey),
        expiresAt,
      })),
    );
  }

  private targetOf(staged: StagedUpload): AttachmentTarget {
    return {
      objectType: staged.policy.objectType,
      objectId: staged.objectId,
      associationType: staged.policy.associationType,
    };
  }
}
