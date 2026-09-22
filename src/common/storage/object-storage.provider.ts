import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { objectStorageConfig } from '../../config/object-storage.config';
import { ObjectStorageUnavailableError } from './object-storage.errors';
import { OBJECT_STORAGE_CLIENT } from './object-storage.tokens';
import type {
  ObjectStorageDelete,
  ObjectStoragePresign,
  ObjectStorageUpload,
} from './object-storage.types';

/**
 * The only path from this application to object storage, for every feature that has
 * one.
 *
 * It owns the provider mechanics - the client, the bounds, the shutdown, and what a
 * missing object means - and nothing about why a caller is storing something. Bounds
 * arrive per call rather than from configuration, because a 5 MiB room image and a
 * 25 MiB workbook do not deserve the same timeout and the alternative is two adapters
 * that drift.
 */
@Injectable()
export class ObjectStorageProvider implements OnApplicationShutdown {
  private readonly logger = new Logger(ObjectStorageProvider.name);

  constructor(
    @Inject(OBJECT_STORAGE_CLIENT) private readonly client: S3Client,
    @Inject(objectStorageConfig.KEY)
    private readonly storage: ConfigType<typeof objectStorageConfig>,
  ) {}

  async putObject(upload: ObjectStorageUpload): Promise<void> {
    // ContentLength is sent explicitly so the provider rejects a truncated body instead
    // of storing a partial object under a key metadata will point at.
    await this.execute('put', upload.timeoutMs, (abortSignal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.storage.bucket,
          Key: upload.objectKey,
          Body: upload.body,
          ContentType: upload.contentType,
          ContentLength: upload.body.byteLength,
          ...(upload.checksumSha256
            ? { ChecksumSHA256: upload.checksumSha256 }
            : {}),
        }),
        { abortSignal },
      ),
    );
  }

  /**
   * Idempotent by contract: the caller asks for the object to be absent, so a provider
   * that reports it missing has already satisfied that. Cleanup retries and crash
   * recovery depend on this.
   */
  async deleteObject(request: ObjectStorageDelete): Promise<void> {
    try {
      await this.execute('delete', request.timeoutMs, (abortSignal) =>
        this.client.send(
          new DeleteObjectCommand({
            Bucket: this.storage.bucket,
            Key: request.objectKey,
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
  async createPresignedGetUrl(request: ObjectStoragePresign): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.storage.bucket,
          Key: request.objectKey,
          ...(request.downloadFilename
            ? {
                ResponseContentDisposition: contentDisposition(
                  request.downloadFilename,
                ),
              }
            : {}),
          ...(request.contentType
            ? { ResponseContentType: request.contentType }
            : {}),
        }),
        { expiresIn: request.ttlSeconds },
      );
    } catch (error) {
      this.report('presign');
      throw new ObjectStorageUnavailableError(error);
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  private async execute<T>(
    operation: 'put' | 'delete',
    timeoutMs: number,
    call: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    // The bound must not be the reason the process stays alive.
    timeout.unref();
    try {
      return await call(abortController.signal);
    } catch (error) {
      // A missing object is the delete contract's success, not a provider failure, so
      // it travels untouched for `deleteObject` to interpret. Only for `delete`: a 404
      // on a put is a missing *bucket*, which is a failure like any other, and letting
      // it past here would hand a caller a raw SDK error carrying provider text in
      // place of the stable unavailable one - unlogged, and unmapped by every
      // translation layer above.
      if (operation === 'delete' && isMissingObjectError(error)) throw error;
      this.report(operation);
      throw new ObjectStorageUnavailableError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** A transport class, never the provider's response body or the object key. */
  private report(operation: string): void {
    this.logger.error({
      event: 'object_storage_failure',
      operation,
      errorCode: 'STORAGE_UNAVAILABLE',
    });
  }
}

/**
 * The download filename, as a header value rather than as text pasted into one.
 *
 * Nothing constrains `downloadFilename` at this boundary - it is whatever a feature
 * decided a browser should save its object as, and the next one to derive it from a
 * room name or a report title would otherwise be able to close the quoted string, add
 * a parameter, or break the header in two with a CRLF. The ASCII form is the fallback
 * every client understands and the RFC 5987 form carries the real name, which is also
 * what makes a non-ASCII filename arrive intact rather than mangled.
 */
function contentDisposition(filename: string): string {
  // An allowlist rather than a list of characters to escape: the fallback is the name
  // a client uses when it cannot read the extended form, and being unable to end the
  // quoted string, start a parameter, or break the header in two is worth more than
  // reproducing a character exactly. The extended form below carries the real name.
  const fallback = filename.replace(/[^A-Za-z0-9._ -]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeExtendedValue(filename)}`;
}

/** RFC 5987 `ext-value`: percent-encoded, including the characters `encodeURIComponent` leaves. */
function encodeExtendedValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
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
