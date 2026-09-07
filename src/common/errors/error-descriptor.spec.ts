import { HttpStatus, NotFoundException } from '@nestjs/common';
import englishErrors from '../../locales/en/errors.json';
import vietnameseErrors from '../../locales/vi/errors.json';
import { ApplicationException } from './application.exception';
import { describeException, errorMessageKeys } from './error-descriptor';
import {
  createValidationException,
  flattenValidationErrors,
} from './validation-errors';

describe('error descriptors', () => {
  it('keeps every stable message key present in both locales', () => {
    const keys = Object.keys(errorMessageKeys).sort();
    expect(Object.keys(englishErrors).sort()).toEqual(keys);
    expect(Object.keys(vietnameseErrors).sort()).toEqual(keys);
    for (const [key, value] of Object.entries(errorMessageKeys)) {
      expect(value).toBe(`errors.${key}`);
    }
  });

  it('maps framework exceptions without exposing their raw messages', () => {
    const descriptor = describeException(
      new NotFoundException('private-resource-value'),
    );

    expect(descriptor).toEqual({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'NOT_FOUND',
      messageKey: errorMessageKeys.notFound,
    });
    expect(JSON.stringify(descriptor)).not.toContain('private-resource-value');
  });

  it('preserves stable application error codes and sanitized details', () => {
    const exception = new ApplicationException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'SERVICE_NOT_READY',
      errorMessageKeys.serviceUnavailable,
      { dependency: 'storage' },
    );

    expect(describeException(exception)).toEqual({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'SERVICE_NOT_READY',
      messageKey: errorMessageKeys.serviceUnavailable,
      details: { dependency: 'storage' },
    });
  });

  it('maps the trusted body-parser payload limit boundary to stable 413', () => {
    const payloadError = Object.assign(new Error('private raw-body message'), {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      type: 'entity.too.large',
    });
    const descriptor = describeException(payloadError);

    expect(descriptor).toEqual({
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      code: 'PAYLOAD_TOO_LARGE',
      messageKey: errorMessageKeys.payloadTooLarge,
    });
    expect(JSON.stringify(descriptor)).not.toContain(
      'private raw-body message',
    );
  });

  it('flattens validation failures to field paths and constraint codes only', () => {
    const details = flattenValidationErrors([
      {
        property: 'profile',
        children: [
          {
            property: 'displayName',
            constraints: {
              isString: 'private validation prose',
              maxLength: 'another private validation message',
            },
          },
        ],
      },
    ]);

    expect(details).toEqual([
      {
        field: 'profile.displayName',
        codes: ['isString', 'maxLength'],
      },
    ]);
    expect(JSON.stringify(details)).not.toContain('private validation');
  });

  it('creates the stable validation exception contract', () => {
    const descriptor = describeException(
      createValidationException([
        {
          property: 'unknown',
          constraints: {
            whitelistValidation: 'property unknown should not exist',
          },
        },
      ]),
    );

    expect(descriptor).toEqual({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_FAILED',
      messageKey: errorMessageKeys.validationFailed,
      details: {
        errors: [
          {
            field: 'unknown',
            codes: ['whitelistValidation'],
          },
        ],
      },
    });
  });
});
