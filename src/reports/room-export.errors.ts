import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const roomExportErrors = {
  createRateLimited: () =>
    new ApplicationException(
      HttpStatus.TOO_MANY_REQUESTS,
      'EXPORT_CREATE_RATE_LIMITED',
      errorMessageKeys.exportCreateRateLimited,
    ),
  /**
   * Also the answer when the limiter itself cannot decide. The budget is spent before
   * a snapshot, a Worker Thread and an upload, so a limiter outage has to fail closed:
   * an unbounded number of exports is the resource exhaustion the budget exists for.
   */
  createUnavailable: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'EXPORT_CREATE_UNAVAILABLE',
      errorMessageKeys.exportCreateUnavailable,
    ),
  /** Returned while the export boundary is disabled, so the rollout has a closed door. */
  createDisabled: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'EXPORT_CREATE_DISABLED',
      errorMessageKeys.exportCreateDisabled,
    ),
};
