import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';
import { I18nService } from 'nestjs-i18n';
import {
  getOrCreateRequestId,
  RequestWithContext,
} from '../http/request-context';
import { describeException } from './error-descriptor';

interface ErrorTranslations {
  errors: {
    amenityCodeConflict: string;
    amenityInUse: string;
    amenityNotFound: string;
    attachmentContentInvalid: string;
    attachmentLimitExceeded: string;
    attachmentMimeUnsupported: string;
    attachmentNotFound: string;
    attachmentOrderInvalid: string;
    attachmentPairInvalid: string;
    attachmentSizeExceeded: string;
    attachmentUploadRateLimited: string;
    attachmentUploadUnavailable: string;
    authenticationFailed: string;
    authorizationUnavailable: string;
    badRequest: string;
    bookingCreateRateLimited: string;
    bookingCreateUnavailable: string;
    bookingChangeEmpty: string;
    bookingNotFound: string;
    bookingPriceOutOfRange: string;
    bookingStateChanged: string;
    bookingStayInvalid: string;
    bookingStatusConflict: string;
    bookingWindowUnavailable: string;
    bookingVersionConflict: string;
    bookingVersionMalformed: string;
    bookingVersionRequired: string;
    conflict: string;
    databaseOverloaded: string;
    forbidden: string;
    identityConflict: string;
    idempotencyKeyInvalid: string;
    idempotencyKeyReused: string;
    internalServerError: string;
    lastAdminDeactivationForbidden: string;
    methodNotAllowed: string;
    notFound: string;
    payloadTooLarge: string;
    roomHasHistory: string;
    roomAlreadyBooked: string;
    roomNotFound: string;
    roomNumberConflict: string;
    roomReferenceNotFound: string;
    roomTimeDatesImmutable: string;
    roomTimeHasHistory: string;
    roomTimeInUse: string;
    roomTimeNotFound: string;
    roomTimeOverlap: string;
    roomTimeRangeInvalid: string;
    roomTypeInUse: string;
    roomTypeNameConflict: string;
    roomTypeNotFound: string;
    roomVersionConflict: string;
    roomVersionMalformed: string;
    roomVersionRequired: string;
    selfDeactivationForbidden: string;
    serviceUnavailable: string;
    sessionInvalid: string;
    stayDateRangeIncomplete: string;
    stayRangeInvalid: string;
    storageUnavailable: string;
    tooManyRequests: string;
    unauthorized: string;
    unprocessableEntity: string;
    userInactive: string;
    userNotFound: string;
    validationFailed: string;
  };
}

export interface ErrorResponseBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  constructor(private readonly i18n: I18nService<ErrorTranslations>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();
    const descriptor = describeException(exception);
    const requestId = getOrCreateRequestId(request, response);
    const message = this.i18n.translate(descriptor.messageKey, {
      lang: request.i18nLang ?? 'en',
    });
    const body: ErrorResponseBody = {
      statusCode: descriptor.statusCode,
      code: descriptor.code,
      message,
      requestId,
      ...(descriptor.details === undefined
        ? {}
        : { details: descriptor.details }),
    };

    response.status(descriptor.statusCode).json(body);
  }
}
