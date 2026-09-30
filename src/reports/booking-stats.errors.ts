import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const bookingStatsErrors = {
  /** An empty, inverted, or longer-than-a-year range. The shape is valid; the span is not. */
  rangeInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'BOOKING_STATS_RANGE_INVALID',
      errorMessageKeys.bookingStatsRangeInvalid,
    ),
  /**
   * Returned while this API process has the stream off. Nothing maintains the read model
   * then, and serving it anyway would present stale numbers as current.
   */
  disabled: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'BOOKING_STATS_DISABLED',
      errorMessageKeys.bookingStatsDisabled,
    ),
  /**
   * A sum past `Number.MAX_SAFE_INTEGER` cannot be sent as the JSON number every other
   * money field uses without losing digits. Refusing is better than a rounded total.
   */
  amountOutOfRange: () =>
    new ApplicationException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'BOOKING_STATS_AMOUNT_OUT_OF_RANGE',
      errorMessageKeys.bookingStatsAmountOutOfRange,
    ),
};
