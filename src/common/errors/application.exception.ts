import { HttpException } from '@nestjs/common';
import { ErrorMessageKey } from './error-descriptor';

export class ApplicationException extends HttpException {
  constructor(
    statusCode: number,
    readonly errorCode: string,
    readonly messageKey: ErrorMessageKey,
    readonly details?: unknown,
  ) {
    super(messageKey, statusCode);
  }
}
