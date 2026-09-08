import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { attachmentsConfig } from '../../config/attachments.config';
import { objectStorageConfig } from '../../config/object-storage.config';
import { filesErrors } from '../files.errors';
import { ATTACHMENT_STORAGE_CLIENT } from './attachment-storage.tokens';

export interface AttachmentUpload {
  objectKey: string;
  body: Buffer;
  contentType: string;
}

/**
 * The only path from the application to object storage. Every call is bounded by
 * the configured timeout so no request or database transaction can wait on the
 * provider indefinitely, and provider failures surface as one stable error.
 */
@Injectable()
export class AttachmentStorageService implements OnApplicationShutdown {
  public constructor(
    @Inject(ATTACHMENT_STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(objectStorageConfig.KEY)
    private readonly storage: ConfigType<typeof objectStorageConfig>,
    @Inject(attachmentsConfig.KEY)
    private readonly attachments: ConfigType<typeof attachmentsConfig>,
  ) {}

  public async putObject(upload: AttachmentUpload): Promise<void> {
    // ContentLength is sent explicitly so the provider rejects a truncated body
    // instead of storing a partial object under a key metadata will point at.
    await this.execute((abortSignal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.storage.bucket,
          Key: upload.objectKey,
          Body: upload.body,
          ContentType: upload.contentType,
          ContentLength: upload.body.byteLength,
        }),
        { abortSignal },
      ),
    );
  }

  /**
   * Idempotent by contract: the caller asks for the object to be absent, so a
   * provider that reports it missing has already satisfied that. Cleanup retries
   * and crash recovery depend on this.
   */
  public async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.execute((abortSignal) =>
        this.client.send(
          new DeleteObjectCommand({
            Bucket: this.storage.bucket,
            Key: objectKey,
          }),
          { abortSignal },
        ),
      );
    } catch (error) {
      if (isMissingObjectError(error)) return;
      throw error;
    }
  }

  /** Private bucket: reads are short-lived presigned GETs, never public URLs. */
  public async createPresignedGetUrl(objectKey: string): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.storage.bucket,
          Key: objectKey,
        }),
        { expiresIn: this.attachments.presignTtlSeconds },
      );
    } catch (error) {
      throw filesErrors.storageUnavailable(error);
    }
  }

  public onApplicationShutdown(): void {
    this.client.destroy();
  }

  private async execute<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(
      () => abortController.abort(),
      this.attachments.storageTimeoutMs,
    );
    timeout.unref();
    try {
      return await operation(abortController.signal);
    } catch (error) {
      if (isMissingObjectError(error)) throw error;
      throw filesErrors.storageUnavailable(error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isMissingObjectError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
