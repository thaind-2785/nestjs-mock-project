import { HttpStatus } from '@nestjs/common';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';

export const roomsErrors = {
  roomTypeNotFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'ROOM_TYPE_NOT_FOUND',
      errorMessageKeys.roomTypeNotFound,
    ),
  roomTypeNameConflict: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ROOM_TYPE_NAME_CONFLICT',
      errorMessageKeys.roomTypeNameConflict,
    ),
  roomTypeInUse: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ROOM_TYPE_IN_USE',
      errorMessageKeys.roomTypeInUse,
    ),
  amenityNotFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'AMENITY_NOT_FOUND',
      errorMessageKeys.amenityNotFound,
    ),
  amenityCodeConflict: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'AMENITY_CODE_CONFLICT',
      errorMessageKeys.amenityCodeConflict,
    ),
  amenityInUse: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'AMENITY_IN_USE',
      errorMessageKeys.amenityInUse,
    ),
  roomNotFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'ROOM_NOT_FOUND',
      errorMessageKeys.roomNotFound,
    ),
  roomReferenceNotFound: () =>
    new ApplicationException(
      HttpStatus.NOT_FOUND,
      'ROOM_REFERENCE_NOT_FOUND',
      errorMessageKeys.roomReferenceNotFound,
    ),
  roomNumberConflict: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ROOM_NUMBER_CONFLICT',
      errorMessageKeys.roomNumberConflict,
    ),
  roomVersionConflict: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ROOM_VERSION_CONFLICT',
      errorMessageKeys.roomVersionConflict,
    ),
  roomHasHistory: () =>
    new ApplicationException(
      HttpStatus.CONFLICT,
      'ROOM_HAS_HISTORY',
      errorMessageKeys.roomHasHistory,
    ),
  emptyUpdate: () =>
    new ApplicationException(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_FAILED',
      errorMessageKeys.validationFailed,
      { errors: [{ field: '$body', codes: ['isNotEmptyObject'] }] },
    ),
};

export function isDatabaseError(error: unknown, code: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  };
  return (candidate.code ?? candidate.driverError?.code) === code;
}
