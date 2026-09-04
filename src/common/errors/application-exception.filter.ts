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
    authenticationFailed: string;
    authorizationUnavailable: string;
    badRequest: string;
    conflict: string;
    forbidden: string;
    internalServerError: string;
    identityConflict: string;
    lastAdminDeactivationForbidden: string;
    methodNotAllowed: string;
    notFound: string;
    payloadTooLarge: string;
    selfDeactivationForbidden: string;
    sessionInvalid: string;
    serviceUnavailable: string;
    tooManyRequests: string;
    unauthorized: string;
    userInactive: string;
    userNotFound: string;
    unprocessableEntity: string;
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
