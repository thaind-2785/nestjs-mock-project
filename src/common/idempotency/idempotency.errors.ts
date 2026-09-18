import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../errors/application.exception';
import { errorMessageKeys } from '../errors/error-descriptor';

/**
 * The idempotency contract is the same wherever it is used, so the errors are too.
 * A caller that invented its own code for a reused key would make one client-visible
 * behaviour depend on which endpoint happened to implement it.
 */
export const idempotencyErrors = {
  keyInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'IDEMPOTENCY_KEY_INVALID',
      errorMessageKeys.idempotencyKeyInvalid,
    ),
  keyReused: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_KEY_REUSED',
      errorMessageKeys.idempotencyKeyReused,
    ),
};
