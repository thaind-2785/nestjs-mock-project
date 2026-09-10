import { randomUUID } from 'node:crypto';
import { decimalIdPattern } from '../../common/constants/identifier.constants';
import { attachmentImageExtensions } from '../attachment.constants';
import type { AttachmentPolicy } from '../attachment-policy';
import { filesErrors } from '../files.errors';

export interface AttachmentObjectKeyInput {
  policy: AttachmentPolicy;
  objectId: string;
  mimeType: string;
}

/**
 * Object keys are generated entirely server-side. The function takes no filename
 * argument at all, so a client-supplied name cannot become a storage path even by
 * mistake: the path is the target tuple plus a random UUID, and the extension comes
 * from the verified MIME type rather than from the upload.
 */
export function buildAttachmentObjectKey({
  policy,
  objectId,
  mimeType,
}: AttachmentObjectKeyInput): string {
  // A target ID that is not a surrogate key is an internal invariant breach, not
  // client input: every route validates the ID before the service resolves it.
  if (!decimalIdPattern.test(objectId)) {
    throw new Error('Attachment target ID must be a decimal surrogate key');
  }
  const extension = policy.allowedMimeTypes.includes(mimeType)
    ? attachmentImageExtensions[mimeType]
    : undefined;
  if (!extension) throw filesErrors.attachmentMimeUnsupported();

  const target = policy.objectType.toLowerCase();
  const association = policy.associationType.toLowerCase();
  // Grouping by target before association keeps every object of one room under a
  // single prefix, which is what target deletion and cleanup reconciliation scan.
  return `attachments/${target}/${objectId}/${association}/${randomUUID()}.${extension}`;
}
