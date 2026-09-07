import { registerAs } from '@nestjs/config';
import {
  EnvironmentVariables,
  validateEnvironment,
} from './environment.validation';

export const supportedRoomImageMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export interface RoomFilesConfiguration {
  allowedMimeTypes: typeof supportedRoomImageMimeTypes;
  maxBytes: number;
  maxAlbumCount: number;
  presignTtlSeconds: number;
  uploadRateLimit: {
    max: number;
    windowSeconds: number;
  };
  storageTimeoutMs: number;
  cleanupGraceMs: number;
}

export function createRoomFilesConfiguration(
  environment: EnvironmentVariables,
): RoomFilesConfiguration {
  return {
    allowedMimeTypes: supportedRoomImageMimeTypes,
    maxBytes: environment.ROOM_IMAGE_MAX_BYTES,
    maxAlbumCount: environment.ROOM_IMAGE_MAX_ALBUM_COUNT,
    presignTtlSeconds: environment.ROOM_IMAGE_PRESIGN_TTL_SECONDS,
    uploadRateLimit: {
      max: environment.ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX,
      windowSeconds: environment.ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    },
    storageTimeoutMs: environment.ROOM_IMAGE_STORAGE_TIMEOUT_MS,
    cleanupGraceMs: environment.ROOM_IMAGE_CLEANUP_GRACE_MS,
  };
}

export const roomFilesConfig = registerAs('roomFiles', () =>
  createRoomFilesConfiguration(validateEnvironment(process.env)),
);
