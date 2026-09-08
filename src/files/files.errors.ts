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
