import type { AttachmentPolicy } from './attachment-policy';
import { filesErrors } from './files.errors';

/**
 * Bytes inspected to identify a format. WebP needs twelve; every accepted format
 * is decided inside this window, so callers never have to buffer more than this to
 * classify content.
 */
export const attachmentSignatureHeadBytes = 12;

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

interface AttachmentSignature {
  mimeType: string;
  matches: (head: Buffer) => boolean;
}

/**
 * The platform accepts exactly three raster formats, so their signatures are
 * checked directly instead of through a general format detector. Each predicate
 * verifies its own length first: a truncated upload must not be classified from
 * bytes that are not there.
 */
const attachmentSignatures: readonly AttachmentSignature[] = [
  {
    mimeType: 'image/jpeg',
    matches: (head) =>
      head.length >= 3 &&
      head[0] === 0xff &&
      head[1] === 0xd8 &&
      head[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    matches: (head) =>
      head.length >= pngSignature.length &&
      head.subarray(0, pngSignature.length).equals(pngSignature),
  },
  {
    mimeType: 'image/webp',
    // A RIFF container is not enough: WAV and AVI share the outer form, so the
    // WEBP form type at offset 8 decides it.
    matches: (head) =>
      head.length >= 12 &&
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * Identifies content from its own bytes. Returns `undefined` for anything outside
 * the accepted formats, including a file that merely claims to be an image.
 */
export function detectAttachmentMimeType(body: Buffer): string | undefined {
  const head = body.subarray(0, attachmentSignatureHeadBytes);
  return attachmentSignatures.find((signature) => signature.matches(head))
    ?.mimeType;
}

export interface AttachmentContent {
  policy: AttachmentPolicy;
  /** What the client claimed, from the multipart part header. Never trusted. */
  declaredMimeType: string;
  body: Buffer;
}

/**
 * Returns the verified MIME type that the object key and stored metadata must use.
 *
 * This is signature verification, not content scanning: bytes that begin with an
 * accepted image header are accepted even if unrelated data trails them. Size and
 * count limits, not this function, bound what a caller can store.
 */
export function verifyAttachmentContent({
  policy,
  declaredMimeType,
  body,
}: AttachmentContent): string {
  // Rejecting the declared type first keeps an obviously unsupported upload from
  // being classified at all, and reports the header the client can fix.
  if (!policy.allowedMimeTypes.includes(declaredMimeType)) {
    throw filesErrors.attachmentMimeUnsupported();
  }
  if (body.byteLength === 0) throw filesErrors.attachmentContentInvalid();
  if (body.byteLength > policy.maxBytes) {
    throw filesErrors.attachmentSizeExceeded();
  }

  const detectedMimeType = detectAttachmentMimeType(body);
  if (
    detectedMimeType === undefined ||
    !policy.allowedMimeTypes.includes(detectedMimeType) ||
    detectedMimeType !== declaredMimeType
  ) {
    throw filesErrors.attachmentContentInvalid();
  }
  return detectedMimeType;
}
