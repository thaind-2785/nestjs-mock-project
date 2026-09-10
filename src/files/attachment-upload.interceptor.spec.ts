import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  PayloadTooLargeException,
} from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { ApplicationException } from '../common/errors/application.exception';
import { AttachmentUploadErrorInterceptor } from './attachment-upload.interceptor';

const interceptor = new AttachmentUploadErrorInterceptor();
const context = {} as ExecutionContext;

function handlerThatThrows(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('AttachmentUploadErrorInterceptor', () => {
  it('reports the multipart size boundary with the attachment code', async () => {
    const caught: unknown = await firstValueFrom(
      interceptor.intercept(
        context,
        handlerThatThrows(new PayloadTooLargeException('File too large')),
      ),
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApplicationException);
    const error = caught as ApplicationException;
    expect(error.getStatus()).toBe(413);
    expect(error.errorCode).toBe('ATTACHMENT_SIZE_EXCEEDED');
  });

  it.each([
    ['a framework error', new BadRequestException('Unexpected field')],
    ['a domain error', new Error('boom')],
  ])('passes %s through unchanged', async (_label, thrown) => {
    const caught: unknown = await firstValueFrom(
      interceptor.intercept(context, handlerThatThrows(thrown)),
    ).catch((error: unknown) => error);

    expect(caught).toBe(thrown);
  });

  it('leaves a successful upload untouched', async () => {
    const response = { id: 'attachment' };

    await expect(
      firstValueFrom(
        interceptor.intercept(context, { handle: () => of(response) }),
      ),
    ).resolves.toBe(response);
  });
});
