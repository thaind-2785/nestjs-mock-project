import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { Attachment } from './entities/attachment.entity';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
  StorageCleanupReason,
} from './entities/attachment.enums';
import { StorageCleanupTask } from './entities/storage-cleanup-task.entity';

/**
 * Attachment positions are shifted through this offset before they are rewritten.
 * The unique `(object_type, object_id, association_type, position)` key would
 * otherwise be violated part-way through a reorder, because MySQL checks it per row
 * rather than at statement end. The offset exceeds every configured album limit and
 * stays inside the column's unsigned range.
 */
export const positionRewriteOffset = 1_000;

export interface AttachmentTarget {
  objectType: AttachmentObjectType;
  objectId: string;
  associationType: AttachmentAssociationType;
}

export interface AttachmentInsert extends AttachmentTarget {
  uploaderUserId: string;
  position: number;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Every read and write is scoped to the full target tuple. A caller that knows an
 * attachment ID but sends another room's ID matches nothing, which is what makes the
 * generic not-found response honest rather than a message choice.
 */
export function findTargetAttachments(
  manager: EntityManager,
  target: AttachmentTarget,
): Promise<Attachment[]> {
  return manager.find(Attachment, {
    where: {
      objectType: target.objectType,
      objectId: target.objectId,
      associationType: target.associationType,
    },
    order: { position: 'ASC', id: 'ASC' },
  });
}

export function findTargetAttachment(
  manager: EntityManager,
  attachmentId: string,
  target: Pick<AttachmentTarget, 'objectType' | 'objectId'>,
): Promise<Attachment | null> {
  return manager.findOne(Attachment, {
    where: {
      id: attachmentId,
      objectType: target.objectType,
      objectId: target.objectId,
    },
  });
}

export async function insertAttachment(
  manager: EntityManager,
  attachment: AttachmentInsert,
): Promise<Attachment> {
  const entity = manager.create(Attachment, {
    id: randomUUID(),
    uploaderUserId: attachment.uploaderUserId,
    objectType: attachment.objectType,
    objectId: attachment.objectId,
    associationType: attachment.associationType,
    position: attachment.position,
    objectKey: attachment.objectKey,
    mimeType: attachment.mimeType,
    sizeBytes: String(attachment.sizeBytes),
  });
  await manager.insert(Attachment, entity);
  return entity;
}

/**
 * A safeguard is written and committed before the object exists, so a crash between
 * the storage write and the metadata commit still leaves a durable deletion intent.
 * `availableAt` is beyond the bounded storage call, or the runner could delete an
 * object whose upload has not finished.
 */
export async function insertUploadSafeguard(
  manager: EntityManager,
  objectKey: string,
  availableAt: Date,
): Promise<void> {
  await manager.insert(StorageCleanupTask, {
    id: randomUUID(),
    objectKey,
    reason: StorageCleanupReason.UploadSafeguard,
    availableAt,
    lockedAt: null,
    lockExpiresAt: null,
    lockedBy: null,
    attempts: 0,
  });
}

/**
 * The safeguard is the hand-off lock between object storage and metadata. A
 * completion transaction must lock it before inserting the live row: if the
 * cleanup worker already claimed (or removed) it, this upload must abort instead
 * of publishing metadata for an object that may be deleted concurrently.
 */
export function lockUploadSafeguard(
  manager: EntityManager,
  objectKey: string,
): Promise<StorageCleanupTask | null> {
  return manager.findOne(StorageCleanupTask, {
    where: {
      objectKey,
      reason: StorageCleanupReason.UploadSafeguard,
    },
    lock: { mode: 'pessimistic_write' },
  });
}

/** Retires the safeguard in the same transaction that makes the object live. */
export async function deleteUploadSafeguard(
  manager: EntityManager,
  objectKey: string,
): Promise<void> {
  await manager.delete(StorageCleanupTask, {
    objectKey,
    reason: StorageCleanupReason.UploadSafeguard,
  });
}

/**
 * Detached objects are queued as immediately claimable work in the same transaction
 * that removes the live association, so a provider failure afterwards cannot leave
 * an object nobody intends to delete.
 */
export async function scheduleDetachedCleanup(
  manager: EntityManager,
  objectKeys: readonly string[],
): Promise<void> {
  if (!objectKeys.length) return;
  const availableAt = new Date();
  await manager.insert(
    StorageCleanupTask,
    objectKeys.map((objectKey) => ({
      id: randomUUID(),
      objectKey,
      reason: StorageCleanupReason.DetachedObject,
      availableAt,
      lockedAt: null,
      lockExpiresAt: null,
      lockedBy: null,
      attempts: 0,
    })),
  );
}

/**
 * Rewrites positions to `0..n-1` in the given order. Both phases run inside the
 * caller's target-locked transaction: the shift moves every row out of the range the
 * final positions occupy, so no intermediate state collides with the unique key.
 */
export async function rewriteAttachmentPositions(
  manager: EntityManager,
  target: AttachmentTarget,
  orderedAttachmentIds: readonly string[],
): Promise<void> {
  if (!orderedAttachmentIds.length) return;
  await manager
    .createQueryBuilder()
    .update(Attachment)
    .set({ position: () => `position + ${positionRewriteOffset}` })
    .where({
      objectType: target.objectType,
      objectId: target.objectId,
      associationType: target.associationType,
    })
    .execute();

  const positionCases = orderedAttachmentIds
    .map((attachmentId, position) => `WHEN :id${position} THEN ${position}`)
    .join(' ');
  const positionParameters = Object.fromEntries(
    orderedAttachmentIds.map((attachmentId, position) => [
      `id${position}`,
      attachmentId,
    ]),
  );
  await manager
    .createQueryBuilder()
    .update(Attachment)
    .set({ position: () => `CASE id ${positionCases} ELSE position END` })
    .where(
      'object_type = :objectType AND object_id = :objectId AND association_type = :associationType',
      target,
    )
    .andWhere('id IN (:...attachmentIds)', {
      attachmentIds: orderedAttachmentIds,
    })
    .setParameters(positionParameters)
    .execute();
}

/**
 * Batched target read for list responses: one statement for a page of targets
 * instead of one per row.
 */
export async function findAttachmentsByTargets(
  manager: EntityManager,
  objectType: AttachmentObjectType,
  objectIds: readonly string[],
  associationType: AttachmentAssociationType,
): Promise<Map<string, Attachment[]>> {
  const grouped = new Map<string, Attachment[]>();
  if (!objectIds.length) return grouped;
  const attachments = await manager.find(Attachment, {
    select: {
      id: true,
      objectId: true,
      associationType: true,
      position: true,
      objectKey: true,
      mimeType: true,
      sizeBytes: true,
    },
    where: {
      objectType,
      objectId: In([...objectIds]),
      associationType,
    },
    order: { position: 'ASC', id: 'ASC' },
  });
  for (const attachment of attachments) {
    const existing = grouped.get(attachment.objectId);
    if (existing) existing.push(attachment);
    else grouped.set(attachment.objectId, [attachment]);
  }
  return grouped;
}
