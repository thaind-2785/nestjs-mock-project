import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const bookingsErrors = {
  changeEmpty: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'BOOKING_CHANGE_EMPTY',
      errorMessageKeys.bookingChangeEmpty,
    ),
  idempotencyKeyInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'IDEMPOTENCY_KEY_INVALID',
      errorMessageKeys.idempotencyKeyInvalid,
    ),
  idempotencyKeyReused: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_KEY_REUSED',
      errorMessageKeys.idempotencyKeyReused,
    ),
  createRateLimited: () =>
    new ApplicationException(
      HttpStatus.TOO_MANY_REQUESTS,
      'BOOKING_CREATE_RATE_LIMITED',
      errorMessageKeys.bookingCreateRateLimited,
    ),
  createUnavailable: () =>
    new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'BOOKING_CREATE_UNAVAILABLE',
      errorMessageKeys.bookingCreateUnavailable,
    ),
  notFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'BOOKING_NOT_FOUND',
      errorMessageKeys.bookingNotFound,
    ),
  statusConflict: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'BOOKING_STATUS_CONFLICT',
      errorMessageKeys.bookingStatusConflict,
    ),
  stateChanged: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'BOOKING_STATE_CHANGED',
      errorMessageKeys.bookingStateChanged,
    ),
  roomAlreadyBooked: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ROOM_ALREADY_BOOKED',
      errorMessageKeys.roomAlreadyBooked,
    ),
  roomNotFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'ROOM_NOT_FOUND',
      errorMessageKeys.roomNotFound,
    ),
  windowUnavailable: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'BOOKING_WINDOW_UNAVAILABLE',
      errorMessageKeys.bookingWindowUnavailable,
    ),
  versionRequired: () =>
    new ApplicationException(
      HttpStatus.PRECONDITION_REQUIRED,
      'BOOKING_VERSION_REQUIRED',
      errorMessageKeys.bookingVersionRequired,
    ),
  versionMalformed: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'BOOKING_VERSION_MALFORMED',
      errorMessageKeys.bookingVersionMalformed,
    ),
  versionConflict: () =>
    new ApplicationException(
      HttpStatus.PRECONDITION_FAILED,
      'BOOKING_VERSION_CONFLICT',
      errorMessageKeys.bookingVersionConflict,
    ),
  stayInvalid: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'BOOKING_STAY_INVALID',
      errorMessageKeys.bookingStayInvalid,
    ),
  priceOutOfRange: () =>
    new ApplicationException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'BOOKING_PRICE_OUT_OF_RANGE',
      errorMessageKeys.bookingPriceOutOfRange,
    ),
};
