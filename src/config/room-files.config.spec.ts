import { validateEnvironment } from './environment.validation';
import {
  createRoomFilesConfiguration,
  supportedRoomImageMimeTypes,
} from './room-files.config';

describe('createRoomFilesConfiguration', () => {
  it('maps the approved Phase 3 room-image policy', () => {
    const configuration = createRoomFilesConfiguration(validateEnvironment({}));

    expect(configuration).toEqual({
      allowedMimeTypes: supportedRoomImageMimeTypes,
      maxBytes: 5 * 1_024 * 1_024,
      maxAlbumCount: 20,
      presignTtlSeconds: 900,
      uploadRateLimit: { max: 10, windowSeconds: 60 },
      storageTimeoutMs: 10_000,
      cleanupGraceMs: 60_000,
    });
  });

  it('maps explicit bounded values', () => {
    const configuration = createRoomFilesConfiguration(
      validateEnvironment({
        ROOM_IMAGE_MAX_BYTES: '1048576',
        ROOM_IMAGE_MAX_ALBUM_COUNT: '5',
        ROOM_IMAGE_PRESIGN_TTL_SECONDS: '300',
        ROOM_IMAGE_UPLOAD_RATE_LIMIT_MAX: '4',
        ROOM_IMAGE_UPLOAD_RATE_LIMIT_WINDOW_SECONDS: '120',
        ROOM_IMAGE_STORAGE_TIMEOUT_MS: '5000',
        ROOM_IMAGE_CLEANUP_GRACE_MS: '15000',
      }),
    );

    expect(configuration).toMatchObject({
      maxBytes: 1_048_576,
      maxAlbumCount: 5,
      presignTtlSeconds: 300,
      uploadRateLimit: { max: 4, windowSeconds: 120 },
      storageTimeoutMs: 5_000,
      cleanupGraceMs: 15_000,
    });
  });
});
