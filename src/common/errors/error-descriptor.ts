import { HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationException } from './application.exception';

export const errorMessageKeys = {
  amenityCodeConflict: 'errors.amenityCodeConflict',
  amenityInUse: 'errors.amenityInUse',
  amenityNotFound: 'errors.amenityNotFound',
  attachmentContentInvalid: 'errors.attachmentContentInvalid',
  attachmentLimitExceeded: 'errors.attachmentLimitExceeded',
  attachmentMimeUnsupported: 'errors.attachmentMimeUnsupported',
  attachmentNotFound: 'errors.attachmentNotFound',
  attachmentOrderInvalid: 'errors.attachmentOrderInvalid',
  attachmentPairInvalid: 'errors.attachmentPairInvalid',
  attachmentSizeExceeded: 'errors.attachmentSizeExceeded',
  attachmentUploadRateLimited: 'errors.attachmentUploadRateLimited',
  attachmentUploadUnavailable: 'errors.attachmentUploadUnavailable',
  authenticationFailed: 'errors.authenticationFailed',
  authorizationUnavailable: 'errors.authorizationUnavailable',
  badRequest: 'errors.badRequest',
  bookingChangeEmpty: 'errors.bookingChangeEmpty',
  bookingCreateRateLimited: 'errors.bookingCreateRateLimited',
  bookingCreateUnavailable: 'errors.bookingCreateUnavailable',
  bookingNotFound: 'errors.bookingNotFound',
  bookingPriceOutOfRange: 'errors.bookingPriceOutOfRange',
  bookingStateChanged: 'errors.bookingStateChanged',
  bookingStatusConflict: 'errors.bookingStatusConflict',
  bookingStayInvalid: 'errors.bookingStayInvalid',
  bookingVersionConflict: 'errors.bookingVersionConflict',
  bookingVersionMalformed: 'errors.bookingVersionMalformed',
  bookingVersionRequired: 'errors.bookingVersionRequired',
  bookingWindowUnavailable: 'errors.bookingWindowUnavailable',
  conflict: 'errors.conflict',
  databaseOverloaded: 'errors.databaseOverloaded',
  forbidden: 'errors.forbidden',
  idempotencyKeyInvalid: 'errors.idempotencyKeyInvalid',
  idempotencyKeyReused: 'errors.idempotencyKeyReused',
  identityConflict: 'errors.identityConflict',
  internalServerError: 'errors.internalServerError',
  lastAdminDeactivationForbidden: 'errors.lastAdminDeactivationForbidden',
  methodNotAllowed: 'errors.methodNotAllowed',
  notFound: 'errors.notFound',
  payloadTooLarge: 'errors.payloadTooLarge',
  roomAlreadyBooked: 'errors.roomAlreadyBooked',
  roomHasHistory: 'errors.roomHasHistory',
  roomNotFound: 'errors.roomNotFound',
  roomNumberConflict: 'errors.roomNumberConflict',
  roomReferenceNotFound: 'errors.roomReferenceNotFound',
  roomTimeDatesImmutable: 'errors.roomTimeDatesImmutable',
  roomTimeHasHistory: 'errors.roomTimeHasHistory',
  roomTimeInUse: 'errors.roomTimeInUse',
  roomTimeNotFound: 'errors.roomTimeNotFound',
  roomTimeOverlap: 'errors.roomTimeOverlap',
  roomTimeRangeInvalid: 'errors.roomTimeRangeInvalid',
  roomTypeInUse: 'errors.roomTypeInUse',
  roomTypeNameConflict: 'errors.roomTypeNameConflict',
  roomTypeNotFound: 'errors.roomTypeNotFound',
  roomVersionConflict: 'errors.roomVersionConflict',
  roomVersionMalformed: 'errors.roomVersionMalformed',
  roomVersionRequired: 'errors.roomVersionRequired',
  selfDeactivationForbidden: 'errors.selfDeactivationForbidden',
  serviceUnavailable: 'errors.serviceUnavailable',
  sessionInvalid: 'errors.sessionInvalid',
  stayDateRangeIncomplete: 'errors.stayDateRangeIncomplete',
  stayRangeInvalid: 'errors.stayRangeInvalid',
  storageUnavailable: 'errors.storageUnavailable',
  tooManyRequests: 'errors.tooManyRequests',
  unauthorized: 'errors.unauthorized',
  unprocessableEntity: 'errors.unprocessableEntity',
  userInactive: 'errors.userInactive',
  userNotFound: 'errors.userNotFound',
  validationFailed: 'errors.validationFailed',
} as const;

export type ErrorMessageKey =
  (typeof errorMessageKeys)[keyof typeof errorMessageKeys];

export interface ErrorDescriptor {
  statusCode: number;
  code: string;
  messageKey: ErrorMessageKey;
  details?: unknown;
}

const httpErrorDescriptors: Readonly<
  Record<number, Omit<ErrorDescriptor, 'statusCode'>>
> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'BAD_REQUEST',
    messageKey: errorMessageKeys.badRequest,
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: 'UNAUTHORIZED',
    messageKey: errorMessageKeys.unauthorized,
  },
  [HttpStatus.FORBIDDEN]: {
    code: 'FORBIDDEN',
    messageKey: errorMessageKeys.forbidden,
  },
  [HttpStatus.NOT_FOUND]: {
    code: 'NOT_FOUND',
    messageKey: errorMessageKeys.notFound,
  },
  [HttpStatus.METHOD_NOT_ALLOWED]: {
    code: 'METHOD_NOT_ALLOWED',
    messageKey: errorMessageKeys.methodNotAllowed,
  },
  [HttpStatus.PAYLOAD_TOO_LARGE]: {
    code: 'PAYLOAD_TOO_LARGE',
    messageKey: errorMessageKeys.payloadTooLarge,
  },
  [HttpStatus.CONFLICT]: {
    code: 'CONFLICT',
    messageKey: errorMessageKeys.conflict,
  },
  [HttpStatus.UNPROCESSABLE_ENTITY]: {
    code: 'UNPROCESSABLE_ENTITY',
    messageKey: errorMessageKeys.unprocessableEntity,
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: 'TOO_MANY_REQUESTS',
    messageKey: errorMessageKeys.tooManyRequests,
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    code: 'SERVICE_UNAVAILABLE',
    messageKey: errorMessageKeys.serviceUnavailable,
  },
  [HttpStatus.INTERNAL_SERVER_ERROR]: {
    code: 'INTERNAL_SERVER_ERROR',
    messageKey: errorMessageKeys.internalServerError,
  },
};

/**
 * mysql2 reports a full acquisition queue as a bare `Error('Queue limit reached.')`
 * with no error code, and TypeORM may hand it back wrapped, so both the message and
 * the wrapper chain are inspected. The message is pinned by a unit test: if a mysql2
 * upgrade changes the wording, that test fails rather than the mapping silently
 * degrading to a 500.
 */
function isDatabaseOverloadedError(exception: unknown, depth = 0): boolean {
  if (depth > 3 || typeof exception !== 'object' || exception === null) {
    return false;
  }

  const candidate = exception as {
    message?: unknown;
    cause?: unknown;
    driverError?: unknown;
  };
  if (
    typeof candidate.message === 'string' &&
    candidate.message.includes('Queue limit reached')
  ) {
    return true;
  }

  return (
    isDatabaseOverloadedError(candidate.driverError, depth + 1) ||
    isDatabaseOverloadedError(candidate.cause, depth + 1)
  );
}

function isPayloadTooLargeError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) {
    return false;
  }

  const candidate = exception as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };

  return (
    candidate.type === 'entity.too.large' &&
    (candidate.status === HttpStatus.PAYLOAD_TOO_LARGE ||
      candidate.statusCode === HttpStatus.PAYLOAD_TOO_LARGE)
  );
}

export function describeException(exception: unknown): ErrorDescriptor {
  if (exception instanceof ApplicationException) {
    return {
      statusCode: exception.getStatus(),
      code: exception.errorCode,
      messageKey: exception.messageKey,
      ...(exception.details === undefined
        ? {}
        : { details: exception.details }),
    };
  }

  // Shedding load is an availability answer, not an internal error: the request was
  // valid and the client may retry once the pool drains.
  if (isDatabaseOverloadedError(exception)) {
    return {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'DATABASE_OVERLOADED',
      messageKey: errorMessageKeys.databaseOverloaded,
    };
  }

  const statusCode = isPayloadTooLargeError(exception)
    ? HttpStatus.PAYLOAD_TOO_LARGE
    : exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  const descriptor =
    httpErrorDescriptors[statusCode] ??
    httpErrorDescriptors[HttpStatus.INTERNAL_SERVER_ERROR];

  return {
    statusCode,
    ...descriptor,
  };
}
