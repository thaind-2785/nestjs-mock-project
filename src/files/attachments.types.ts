import { AttachmentPolicy } from './attachment-policy';
import { Attachment } from './entities/attachment.entity';

export interface AttachmentStageInput {
  policy: AttachmentPolicy;
  objectId: string;
  declaredMimeType: string;
  body: Buffer;
}

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
