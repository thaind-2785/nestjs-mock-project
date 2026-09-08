import { HttpException } from '@nestjs/common';
import { ErrorMessageKey } from './error-descriptor';

export class ApplicationException extends HttpException {
  constructor(
    statusCode: number,
    readonly errorCode: string,
    readonly messageKey: ErrorMessageKey,
    readonly details?: unknown,
    // Kept for server-side diagnosis only. `describeException` publishes the code,
    // message key, and details, never the cause, so provider text, bucket names,
    // and object keys stay out of the response body.
    cause?: unknown,
  ) {
    super(messageKey, statusCode, cause === undefined ? undefined : { cause });
  }
}
