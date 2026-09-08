import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

/**
 * Attachment configuration separates two concerns deliberately.
 *
 * The infrastructure limits below are shared by every attachable target, because
 * one storage adapter and one cleanup runner serve all of them: room images today,
 * a user avatar or any later target without new variables.
 *
 * Content limits stay per target/association, because "how large may a room album
 * photo be" is a product decision per surface, not a property of the storage layer.
 * `src/files/attachment-policy.ts` turns these values into the per-pair policy.
 */
export interface AttachmentsConfiguration {
  presignTtlSeconds: number;
  storageTimeoutMs: number;
  cleanupGraceMs: number;
  uploadRateLimit: {
    max: number;
    windowSeconds: number;
  };
  roomImage: {
    maxBytes: number;
    maxAlbumCount: number;
  };
}

export function createAttachmentsConfiguration(
  environment: EnvironmentVariables,
): AttachmentsConfiguration {
  return {
    presignTtlSeconds: environment.ATTACHMENT_PRESIGN_TTL_SECONDS,
    storageTimeoutMs: environment.ATTACHMENT_STORAGE_TIMEOUT_MS,
    cleanupGraceMs: environment.ATTACHMENT_CLEANUP_GRACE_MS,
    uploadRateLimit: {
      max: environment.ATTACHMENT_UPLOAD_RATE_LIMIT_MAX,
      windowSeconds: environment.ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    },
    roomImage: {
      maxBytes: environment.ROOM_IMAGE_MAX_BYTES,
      maxAlbumCount: environment.ROOM_IMAGE_MAX_ALBUM_COUNT,
    },
  };
}

export const attachmentsConfig = registerAs('attachments', () =>
  createAttachmentsConfiguration(validateEnvironment(process.env)),
);
