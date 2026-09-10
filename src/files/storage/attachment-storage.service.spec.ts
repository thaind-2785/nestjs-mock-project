import { S3Client } from '@aws-sdk/client-s3';
import { ApplicationException } from '../../common/errors/application.exception';
import { createObjectStorageClientOptions } from '../../common/storage/object-storage-client';
import { createAttachmentsConfiguration } from '../../config/attachments.config';
import { validateEnvironment } from '../../config/environment.validation';
import { createObjectStorageConfiguration } from '../../config/object-storage.config';
import { AttachmentStorageService } from './attachment-storage.service';

const environment = validateEnvironment({
  OBJECT_STORAGE_BUCKET: 'hotel-assets',
  ATTACHMENT_STORAGE_TIMEOUT_MS: '150',
  ATTACHMENT_CLEANUP_GRACE_MS: '5000',
  ATTACHMENT_PRESIGN_TTL_SECONDS: '300',
});
const storage = createObjectStorageConfiguration(environment);
const attachments = createAttachmentsConfiguration(environment);

interface StubClient {
  send: jest.Mock;
  destroy: jest.Mock;
}

function createService(send: jest.Mock): {
  service: AttachmentStorageService;
  client: StubClient;
} {
  const client: StubClient = { send, destroy: jest.fn() };
  return {
    service: new AttachmentStorageService(
      client as unknown as S3Client,
      storage,
      attachments,
    ),
    client,
  };
}

function expectStorageUnavailable(error: unknown): ApplicationException {
  expect(error).toBeInstanceOf(ApplicationException);
  const applicationError = error as ApplicationException;
  expect(applicationError.getStatus()).toBe(503);
  expect(applicationError.errorCode).toBe('STORAGE_UNAVAILABLE');
  return applicationError;
}

describe('AttachmentStorageService', () => {
  it('writes the object with its bucket, verified type, and explicit length', async () => {
    const send = jest.fn().mockResolvedValue({});
    const { service } = createService(send);
    const body = Buffer.from('binary-image-bytes');

    await service.putObject({
      objectKey: 'attachments/room/42/album/object.jpg',
      body,
      contentType: 'image/jpeg',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0] as [
      { input: Record<string, unknown> },
      { abortSignal?: AbortSignal },
    ];
    expect(command.input).toEqual({
      Bucket: 'hotel-assets',
      Key: 'attachments/room/42/album/object.jpg',
      Body: body,
      ContentType: 'image/jpeg',
      ContentLength: body.byteLength,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('maps a provider failure to one stable error and keeps the cause private', async () => {
    const providerFailure = new Error('AccessDenied for bucket hotel-assets');
    const { service } = createService(
      jest.fn().mockRejectedValue(providerFailure),
    );

    const error: unknown = await service
      .putObject({
        objectKey: 'attachments/room/42/album/object.jpg',
        body: Buffer.from('bytes'),
        contentType: 'image/jpeg',
      })
      .catch((caught: unknown) => caught);

    const applicationError = expectStorageUnavailable(error);
    // The provider text stays on the cause, which the response body never carries.
    expect(applicationError.details).toBeUndefined();
    expect(applicationError.cause).toBe(providerFailure);
  });

  it('aborts a call that outlives the configured timeout', async () => {
    const send = jest.fn(
      (_command: unknown, options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('Request aborted'), {
                name: 'AbortError',
              }),
            );
          });
        }),
    );
    const { service } = createService(send);

    const started = Date.now();
    const error: unknown = await service
      .deleteObject('attachments/room/42/album/object.jpg')
      .catch((caught: unknown) => caught);

    expectStorageUnavailable(error);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each([
    ['NoSuchKey', Object.assign(new Error('missing'), { name: 'NoSuchKey' })],
    ['NotFound', Object.assign(new Error('missing'), { name: 'NotFound' })],
    [
      'HTTP 404',
      Object.assign(new Error('missing'), {
        $metadata: { httpStatusCode: 404 },
      }),
    ],
  ])(
    'treats delete of an absent object as done (%s)',
    async (_label, failure) => {
      const { service } = createService(jest.fn().mockRejectedValue(failure));

      await expect(
        service.deleteObject('attachments/room/42/album/object.jpg'),
      ).resolves.toBeUndefined();
    },
  );

  it('still reports a delete that failed for another reason', async () => {
    const { service } = createService(
      jest.fn().mockRejectedValue(new Error('InternalError')),
    );

    const error: unknown = await service
      .deleteObject('attachments/room/42/album/object.jpg')
      .catch((caught: unknown) => caught);

    expectStorageUnavailable(error);
  });

  it('signs a short-lived read of the private object', async () => {
    const client = new S3Client(createObjectStorageClientOptions(storage));
    const service = new AttachmentStorageService(client, storage, attachments);

    try {
      const url = new URL(
        await service.createPresignedGetUrl(
          'attachments/room/42/album/object.jpg',
        ),
      );

      expect(url.origin).toBe('http://127.0.0.1:9000');
      expect(url.pathname).toBe(
        '/hotel-assets/attachments/room/42/album/object.jpg',
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      client.destroy();
    }
  });

  it('releases the client on shutdown', () => {
    const { service, client } = createService(jest.fn());

    service.onApplicationShutdown();

    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
