import { HttpStatus } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { ApplicationException } from './application.exception';
import { errorMessageKeys } from './error-descriptor';

export interface ValidationErrorDetail {
  field: string;
  codes: string[];
}

export interface ValidationErrorDetails {
  errors: ValidationErrorDetail[];
}

export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): ValidationErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    const codes = Object.keys(error.constraints ?? {}).sort();
    const current = codes.length > 0 ? [{ field, codes }] : [];

    return [
      ...current,
      ...flattenValidationErrors(error.children ?? [], field),
    ];
  });
}

export function createValidationException(
  errors: ValidationError[],
): ApplicationException {
  const details: ValidationErrorDetails = {
    errors: flattenValidationErrors(errors),
  };

  return new ApplicationException(
    HttpStatus.BAD_REQUEST,
    'VALIDATION_FAILED',
    errorMessageKeys.validationFailed,
    details,
  );
}
