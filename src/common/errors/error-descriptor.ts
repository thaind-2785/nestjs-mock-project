import { HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationException } from './application.exception';

export const errorMessageKeys = {
  amenityCodeConflict: 'errors.amenityCodeConflict',
  amenityInUse: 'errors.amenityInUse',
  amenityNotFound: 'errors.amenityNotFound',
  attachmentMimeUnsupported: 'errors.attachmentMimeUnsupported',
  attachmentPairInvalid: 'errors.attachmentPairInvalid',
  authenticationFailed: 'errors.authenticationFailed',
  authorizationUnavailable: 'errors.authorizationUnavailable',
  badRequest: 'errors.badRequest',
  conflict: 'errors.conflict',
  forbidden: 'errors.forbidden',
  identityConflict: 'errors.identityConflict',
  internalServerError: 'errors.internalServerError',
  lastAdminDeactivationForbidden: 'errors.lastAdminDeactivationForbidden',
  methodNotAllowed: 'errors.methodNotAllowed',
  notFound: 'errors.notFound',
  payloadTooLarge: 'errors.payloadTooLarge',
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
