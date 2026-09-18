import { S3Client } from '@aws-sdk/client-s3';
import { validateEnvironment } from '../../config/environment.validation';
import { createObjectStorageConfiguration } from '../../config/object-storage.config';
import { createObjectStorageClientOptions } from './object-storage-client';
import { ObjectStorageUnavailableError } from './object-storage.errors';
import { ObjectStorageProvider } from './object-storage.provider';

const storage = createObjectStorageConfiguration(
  validateEnvironment({ OBJECT_STORAGE_BUCKET: 'hotel-assets' }),
);

function providerWith(send: jest.Mock): ObjectStorageProvider {
  return new ObjectStorageProvider(
    { send, destroy: jest.fn() } as unknown as S3Client,
    storage,
  );
}

function providerError(
  name: string,
  httpStatusCode: number,
): Error & { $metadata: { httpStatusCode: number } } {
  const error = new Error(`${name}: the provider said so`) as Error & {
    $metadata: { httpStatusCode: number };
  };
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

describe('ObjectStorageProvider', () => {
  it('reports a 404 on a write as the provider failure it is', async () => {
    // A missing object is the delete contract's success; a missing bucket on a put is
    // not, and it arrives wearing the same 404. Letting it past the wrapper would hand
    // a caller a raw SDK error carrying provider text - unlogged, and unmapped by every
    // translation layer above, so an administrator would see a 500 with a bucket name
    // in it instead of the stable unavailable answer.
    const send = jest
      .fn()
      .mockRejectedValue(providerError('NoSuchBucket', 404));
    const failure: unknown = await providerWith(send)
      .putObject({
        objectKey: 'exports/rooms/job/token.xlsx',
        body: Buffer.from('workbook'),
        contentType: 'application/octet-stream',
        timeoutMs: 100,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ObjectStorageUnavailableError);
  });

  it('still treats a missing object as a delete that has already succeeded', async () => {
    const send = jest.fn().mockRejectedValue(providerError('NoSuchKey', 404));

    await expect(
      providerWith(send).deleteObject({
        objectKey: 'exports/rooms/job/token.xlsx',
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
  });

  it('gives the signed URL a disposition header a filename cannot break out of', async () => {
    const client = new S3Client(createObjectStorageClientOptions(storage));
    const provider = new ObjectStorageProvider(client, storage);

    try {
      const url = new URL(
        await provider.createPresignedGetUrl({
          objectKey: 'exports/rooms/job/token.xlsx',
          ttlSeconds: 300,
          // Nothing constrains this field at the adapter boundary, and the first caller
          // to derive a filename from a room name or a report title would otherwise be
          // able to write its own header parameters.
          downloadFilename: 'rooms.xlsx"; attachment\r\nX-Injected: 1',
        }),
      );
      const disposition =
        url.searchParams.get('response-content-disposition') ?? '';

      expect(disposition).toBe(
        'attachment; filename="rooms.xlsx__ attachment__X-Injected_ 1"; ' +
          "filename*=UTF-8''rooms.xlsx%22%3B%20attachment%0D%0AX-Injected%3A%201",
      );
      expect(disposition).not.toMatch(/[\r\n]/);
    } finally {
      client.destroy();
    }
  });

  it('leaves an ordinary filename readable in both forms', async () => {
    const client = new S3Client(createObjectStorageClientOptions(storage));
    const provider = new ObjectStorageProvider(client, storage);

    try {
      const url = new URL(
        await provider.createPresignedGetUrl({
          objectKey: 'exports/rooms/job/token.xlsx',
          ttlSeconds: 300,
          downloadFilename: 'rooms-export-018f6f4e.xlsx',
        }),
      );

      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="rooms-export-018f6f4e.xlsx"; ' +
          "filename*=UTF-8''rooms-export-018f6f4e.xlsx",
      );
    } finally {
      client.destroy();
    }
  });
});
