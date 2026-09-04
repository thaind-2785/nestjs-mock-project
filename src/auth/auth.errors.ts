import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const authErrors = {
  oauthTransactionInvalid: () =>
    new ApplicationException(
      HttpStatus.UNAUTHORIZED,
      'OAUTH_TRANSACTION_INVALID',
      errorMessageKeys.authenticationFailed,
    ),
  googleAuthenticationFailed: () =>
    new ApplicationException(
      HttpStatus.UNAUTHORIZED,
      'GOOGLE_AUTHENTICATION_FAILED',
      errorMessageKeys.authenticationFailed,
    ),
  googleAuthenticationUnavailable: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'GOOGLE_AUTHENTICATION_UNAVAILABLE',
      errorMessageKeys.serviceUnavailable,
    ),
  identityConflict: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'IDENTITY_CONFLICT',
      errorMessageKeys.identityConflict,
    ),
  sessionInvalid: () =>
    new ApplicationException(
      HttpStatus.UNAUTHORIZED,
      'SESSION_INVALID',
      errorMessageKeys.sessionInvalid,
    ),
  userInactive: () =>
    new ApplicationException(
      HttpStatus.FORBIDDEN,
      'USER_INACTIVE',
      errorMessageKeys.userInactive,
    ),
  authorizationUnavailable: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'AUTHORIZATION_UNAVAILABLE',
      errorMessageKeys.authorizationUnavailable,
    ),
  rateLimited: () =>
    new ApplicationException(
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_RATE_LIMITED',
      errorMessageKeys.tooManyRequests,
    ),
};
