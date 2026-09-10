import { ExecutionContext } from '@nestjs/common';
import { AttachmentUploadRateLimitGuard } from './attachment-upload-rate-limit.guard';
import { AttachmentsService } from './attachments.service';
import { filesErrors } from './files.errors';

describe('AttachmentUploadRateLimitGuard', () => {
  function createContext(request: unknown): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function createGuard(assertUploadAllowed: jest.Mock) {
    return new AttachmentUploadRateLimitGuard({
      assertUploadAllowed,
    } as unknown as AttachmentsService);
  }

  it('charges the verified principal and admits the request', async () => {
    const assertUploadAllowed = jest.fn().mockResolvedValue(undefined);
    const guard = createGuard(assertUploadAllowed);

    await expect(
      guard.canActivate(
        createContext({
          principal: { userId: 'admin-id', sessionId: 'session' },
        }),
      ),
    ).resolves.toBe(true);
    // The budget follows the token identity, never a body or header field.
    expect(assertUploadAllowed).toHaveBeenCalledWith('admin-id');
  });

  it('propagates the refusal so the route answers before reading the body', async () => {
    const refusal = filesErrors.attachmentUploadRateLimited();
    const guard = createGuard(jest.fn().mockRejectedValue(refusal));

    await expect(
      guard.canActivate(createContext({ principal: { userId: 'admin-id' } })),
    ).rejects.toBe(refusal);
  });

  it('fails closed when the request carries no authenticated principal', async () => {
    const assertUploadAllowed = jest.fn();
    const guard = createGuard(assertUploadAllowed);

    await expect(guard.canActivate(createContext({}))).rejects.toMatchObject({
      errorCode: 'ATTACHMENT_UPLOAD_UNAVAILABLE',
    });
    expect(assertUploadAllowed).not.toHaveBeenCalled();
  });
});
