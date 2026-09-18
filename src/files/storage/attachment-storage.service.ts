import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ObjectStorageUnavailableError } from '../../common/storage/object-storage.errors';
import { ObjectStorageProvider } from '../../common/storage/object-storage.provider';
import { attachmentsConfig } from '../../config/attachments.config';
import { filesErrors } from '../files.errors';
import type { AttachmentUpload } from './attachment-storage.types';

/**
 * Attachment policy over the shared storage adapter.
 *
 * What is left here after the provider extraction is exactly what is specific to
 * attachments: which timeout bounds their calls, how long their presigned URLs live,
 * and which stable error the API returns when the provider cannot answer. The
 * mechanics - the client, the abort, the shutdown, what a missing object means - are
 * shared with the room export, because both upload to the same bucket with the same
 * credentials and a second implementation would drift from this one.
 */
@Injectable()
export class AttachmentStorageService {
  public constructor(
    private readonly storage: ObjectStorageProvider,
    @Inject(attachmentsConfig.KEY)
    private readonly attachments: ConfigType<typeof attachmentsConfig>,
  ) {}

  public async putObject(upload: AttachmentUpload): Promise<void> {
    await this.translate(() =>
      this.storage.putObject({
        objectKey: upload.objectKey,
        body: upload.body,
        contentType: upload.contentType,
        timeoutMs: this.attachments.storageTimeoutMs,
      }),
    );
  }

  /** Idempotent: an absent object already satisfies the caller's request. */
  public async deleteObject(objectKey: string): Promise<void> {
    await this.translate(() =>
      this.storage.deleteObject({
        objectKey,
        timeoutMs: this.attachments.storageTimeoutMs,
      }),
    );
  }

  public async createPresignedGetUrl(objectKey: string): Promise<string> {
    return this.translate(() =>
      this.storage.createPresignedGetUrl({
        objectKey,
        ttlSeconds: this.attachments.presignTtlSeconds,
      }),
    );
  }

  /**
   * The provider raises one neutral failure; the API answers with its own. Keeping the
   * mapping here rather than in the adapter is what lets the export path answer
   * differently for the same underlying fault.
   */
  private async translate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ObjectStorageUnavailableError) {
        // The provider's own wrapper is unwrapped rather than nested. The adapter
        // boundary is an implementation detail; what a developer needs from the cause
        // is the provider's fault, and a chain that grows a link per layer buries it.
        throw filesErrors.storageUnavailable(error.cause ?? error);
      }
      throw error;
    }
  }
}
