import { createAttachmentsConfiguration } from './attachments.config';
import { validateEnvironment } from './environment.validation';

describe('createAttachmentsConfiguration', () => {
  it('maps the accepted Phase 3 defaults', () => {
    const configuration = createAttachmentsConfiguration(
      validateEnvironment({}),
    );

    expect(configuration).toEqual({
      presignTtlSeconds: 900,
      storageTimeoutMs: 10_000,
      cleanupGraceMs: 60_000,
      uploadRateLimit: { max: 10, windowSeconds: 60 },
      roomImage: { maxBytes: 5 * 1_024 * 1_024, maxAlbumCount: 20 },
    });
  });

  it('maps explicit bounded values, keeping infrastructure and content separate', () => {
    const configuration = createAttachmentsConfiguration(
      validateEnvironment({
        ATTACHMENT_PRESIGN_TTL_SECONDS: '300',
        ATTACHMENT_UPLOAD_RATE_LIMIT_MAX: '4',
        ATTACHMENT_UPLOAD_RATE_LIMIT_WINDOW_SECONDS: '120',
        ATTACHMENT_STORAGE_TIMEOUT_MS: '5000',
        ATTACHMENT_CLEANUP_GRACE_MS: '15000',
        ROOM_IMAGE_MAX_BYTES: '1048576',
        ROOM_IMAGE_MAX_ALBUM_COUNT: '5',
      }),
    );

    expect(configuration).toEqual({
      presignTtlSeconds: 300,
      storageTimeoutMs: 5_000,
      cleanupGraceMs: 15_000,
      uploadRateLimit: { max: 4, windowSeconds: 120 },
      roomImage: { maxBytes: 1_048_576, maxAlbumCount: 5 },
    });
  });

  it('rejects a cleanup grace that cannot outlive the bounded storage call', () => {
    expect(() =>
      validateEnvironment({
        ATTACHMENT_STORAGE_TIMEOUT_MS: '10000',
        ATTACHMENT_CLEANUP_GRACE_MS: '10000',
      }),
    ).toThrow('Environment validation failed for: ATTACHMENT_CLEANUP_GRACE_MS');
  });
});
