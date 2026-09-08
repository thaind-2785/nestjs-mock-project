import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { filesErrors } from './files.errors';

/**
 * Multipart parsing aborts at the configured byte limit before the content policy
 * can run, and the framework reports that as a generic payload-too-large error.
 * Both boundaries describe the same situation to the caller, so they must return the
 * same stable code. Register this before the file interceptor.
 */
@Injectable()
export class AttachmentUploadErrorInterceptor implements NestInterceptor {
  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    void context;
    return next
      .handle()
      .pipe(
        catchError((error: unknown) =>
          throwError(() =>
            error instanceof PayloadTooLargeException
              ? filesErrors.attachmentSizeExceeded()
              : error,
          ),
        ),
      );
  }
}
