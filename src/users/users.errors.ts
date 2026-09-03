import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const usersErrors = {
  notFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'USER_NOT_FOUND',
      errorMessageKeys.userNotFound,
    ),
  selfDeactivationForbidden: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'SELF_DEACTIVATION_FORBIDDEN',
      errorMessageKeys.selfDeactivationForbidden,
    ),
  lastAdminDeactivationForbidden: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'LAST_ADMIN_DEACTIVATION_FORBIDDEN',
      errorMessageKeys.lastAdminDeactivationForbidden,
    ),
};
