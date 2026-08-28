import { HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationException } from './application.exception';

export const errorMessageKeys = {
  badRequest: 'errors.badRequest',
  conflict: 'errors.conflict',
  forbidden: 'errors.forbidden',
  internalServerError: 'errors.internalServerError',
  methodNotAllowed: 'errors.methodNotAllowed',
  notFound: 'errors.notFound',
  payloadTooLarge: 'errors.payloadTooLarge',
  serviceUnavailable: 'errors.serviceUnavailable',
  tooManyRequests: 'errors.tooManyRequests',
  unauthorized: 'errors.unauthorized',
  unprocessableEntity: 'errors.unprocessableEntity',
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
