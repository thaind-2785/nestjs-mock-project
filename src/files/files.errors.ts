import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const filesErrors = {
  /**
   * The requested target type/association pair is not in the registry. Phase 3
   * endpoints resolve the pair server-side, so this protects the invariant when a
   * later surface accepts a target from the request.
   */
  attachmentPairInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'ATTACHMENT_PAIR_INVALID',
      errorMessageKeys.attachmentPairInvalid,
    ),
  attachmentMimeUnsupported: () =>
    new ApplicationException(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'ATTACHMENT_MIME_UNSUPPORTED',
      errorMessageKeys.attachmentMimeUnsupported,
    ),
  /**
   * Generic by design: a mismatched attachment ID, a foreign target, and an absent
   * row are indistinguishable, so an admin of one room cannot probe another's media.
   */
  attachmentNotFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'ATTACHMENT_NOT_FOUND',
      errorMessageKeys.attachmentNotFound,
    ),
  attachmentLimitExceeded: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ATTACHMENT_LIMIT_EXCEEDED',
      errorMessageKeys.attachmentLimitExceeded,
    ),
  /** The reorder payload is not exactly the current album, so no order is implied. */
  attachmentOrderInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'ATTACHMENT_ORDER_INVALID',
      errorMessageKeys.attachmentOrderInvalid,
    ),
  /** The bytes are not one of the accepted formats, whatever the client declared. */
  attachmentContentInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'ATTACHMENT_CONTENT_INVALID',
      errorMessageKeys.attachmentContentInvalid,
    ),
  attachmentSizeExceeded: () =>
    new ApplicationException(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'ATTACHMENT_SIZE_EXCEEDED',
      errorMessageKeys.attachmentSizeExceeded,
    ),
  /**
   * The uploader spent its shared upload budget. Counting the attempt before the
   * signature check, the key generation, and the storage call is deliberate: a flood
   * must cost one Redis counter, not a provider round trip.
   */
  attachmentUploadRateLimited: () =>
    new ApplicationException(
      HttpStatus.TOO_MANY_REQUESTS,
      'ATTACHMENT_UPLOAD_RATE_LIMITED',
      errorMessageKeys.attachmentUploadRateLimited,
    ),
  /**
   * The limiter itself is unreachable. Uploads fail closed, because an unbounded
   * upload path is a storage-cost and memory risk, not a degraded read.
   */
  attachmentUploadUnavailable: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'ATTACHMENT_UPLOAD_UNAVAILABLE',
      errorMessageKeys.attachmentUploadUnavailable,
    ),
  /**
   * The object-storage provider failed or exceeded its bounded timeout. The cause
   * is kept for diagnosis but never published: it can carry bucket names, object
   * keys, and provider text.
   */
  storageUnavailable: (cause?: unknown) =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'STORAGE_UNAVAILABLE',
      errorMessageKeys.storageUnavailable,
      undefined,
      cause,
    ),
};
