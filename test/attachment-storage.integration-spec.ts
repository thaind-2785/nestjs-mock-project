import { randomInt } from 'node:crypto';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createObjectStorageClientOptions } from '../src/common/storage/object-storage-client';
import {
  AttachmentsConfiguration,
  createAttachmentsConfiguration,
} from '../src/config/attachments.config';
import { validateEnvironment } from '../src/config/environment.validation';
import {
  createObjectStorageConfiguration,
  ObjectStorageConfiguration,
} from '../src/config/object-storage.config';
import { AttachmentPolicyRegistry } from '../src/files/attachment-policy';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from '../src/files/entities/attachment.enums';
import { buildAttachmentObjectKey } from '../src/files/storage/attachment-object-key';
import { AttachmentStorageService } from '../src/files/storage/attachment-storage.service';

jest.setTimeout(30_000);

// A real 1x1 PNG: signature verification and content-type round trips are only
// meaningful against bytes a provider would actually accept.
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Phase 3 attachment storage against MinIO', () => {
  let storage: ObjectStorageConfiguration;
  let attachments: AttachmentsConfiguration;
  let client: S3Client;
  let service: AttachmentStorageService;
  let albumPolicy: ReturnType<AttachmentPolicyRegistry['resolve']>;
  // Every object of this run lives under one target prefix, so a failed run can
  // never leave objects that a later run confuses for its own.
  const objectId = String(randomInt(1_000_000, 9_999_999));
  const writtenKeys: string[] = [];

  beforeAll(async () => {
    const environment = validateEnvironment(process.env);
    storage = createObjectStorageConfiguration(environment);
    attachments = createAttachmentsConfiguration(environment);
    client = new S3Client(createObjectStorageClientOptions(storage));
    service = new AttachmentStorageService(client, storage, attachments);
    albumPolicy = new AttachmentPolicyRegistry(attachments).resolve(
      AttachmentObjectType.Room,
      AttachmentAssociationType.Album,
    );

    try {
      await client.send(new HeadBucketCommand({ Bucket: storage.bucket }));
    } catch {
      // Managed environments provision the private bucket out of band with
      // least-privilege credentials; the local stack creates it on demand.
      try {
        await client.send(new CreateBucketCommand({ Bucket: storage.bucket }));
      } catch (error) {
        throw new Error(
          `Attachment storage integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });

  afterAll(async () => {
    for (const objectKey of writtenKeys) {
      await service.deleteObject(objectKey).catch(() => undefined);
    }
    client.destroy();
  });

  function nextObjectKey(): string {
    const objectKey = buildAttachmentObjectKey({
      policy: albumPolicy,
      objectId,
      mimeType: 'image/png',
    });
    writtenKeys.push(objectKey);
    return objectKey;
  }

  it('writes a private object that is readable only through a presigned URL', async () => {
    const objectKey = nextObjectKey();
    await service.putObject({
      objectKey,
      body: pngBytes,
      contentType: 'image/png',
    });

    const anonymous = await fetch(
      `${storage.endpoint ?? ''}/${storage.bucket}/${objectKey}`,
    );
    expect(anonymous.status).toBe(403);

    const presigned = await fetch(
      await service.createPresignedGetUrl(objectKey),
    );
    expect(presigned.status).toBe(200);
    expect(presigned.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await presigned.arrayBuffer())).toEqual(pngBytes);
  });

  it('deletes the object and stays successful when it is already gone', async () => {
    const objectKey = nextObjectKey();
    await service.putObject({
      objectKey,
      body: pngBytes,
      contentType: 'image/png',
    });
    const readUrl = await service.createPresignedGetUrl(objectKey);

    await service.deleteObject(objectKey);
    expect((await fetch(readUrl)).status).toBe(404);

    // Cleanup retries and crash recovery replay the same delete.
    await expect(service.deleteObject(objectKey)).resolves.toBeUndefined();
  });

  it('bounds a call to an unreachable provider instead of hanging', async () => {
    const unreachable = new S3Client(
      createObjectStorageClientOptions({
        ...storage,
        // Reserved TEST-NET-1 address: connections are dropped, not refused.
        endpoint: 'http://192.0.2.1:9000',
      }),
    );
    const boundedService = new AttachmentStorageService(unreachable, storage, {
      ...attachments,
      storageTimeoutMs: 250,
    });

    try {
      const started = Date.now();
      await expect(
        boundedService.putObject({
          objectKey: nextObjectKey(),
          body: pngBytes,
          contentType: 'image/png',
        }),
      ).rejects.toMatchObject({
        errorCode: 'STORAGE_UNAVAILABLE',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      unreachable.destroy();
    }
  });
});
