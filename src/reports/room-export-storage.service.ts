import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ObjectStorageUnavailableError } from '../common/storage/object-storage.errors';
import { ObjectStorageProvider } from '../common/storage/object-storage.provider';
import { reportsConfig } from '../config/reports.config';
import {
  roomExportContentType,
  roomExportDownloadFilename,
  roomExportObjectKeyPrefix,
} from './room-export.constants';
import { roomExportErrors } from './room-export.errors';
import type { RoomExportUpload } from './room-export-storage.types';

/**
 * Export policy over the shared storage adapter: which key, which bounds, which
 * filename a browser sees, and which stable error an administrator reads.
 */
@Injectable()
export class RoomExportStorageService {
  constructor(
    private readonly storage: ObjectStorageProvider,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  /**
   * One key per attempt, never per job.
   *
   * A job-ID-only key would let a worker that lost its claim overwrite the object the
   * winning attempt had already published - it would still be holding a buffer and a
   * key that look correct to it. The claim token makes the loser's key its own, so the
   * worst it can do is leave an object the cleanup safeguard already covers.
   *
   * The key is built from a fixed prefix, the job UUID and the token. Nothing a client
   * sent reaches it, so no filter or room name can steer where an object lands.
   */
  stagingObjectKey(jobId: string, claimToken: string): string {
    return `${roomExportObjectKeyPrefix}/${jobId}/${claimToken}.xlsx`;
  }

  async upload(upload: RoomExportUpload): Promise<void> {
    await this.translate(() =>
      this.storage.putObject({
        objectKey: upload.objectKey,
        body: upload.body,
        contentType: roomExportContentType,
        timeoutMs: this.configuration.storage.timeoutMs,
        // The provider verifies this against what it received, so a body corrupted in
        // transit is refused rather than stored under a key the job will point at.
        checksumSha256: Buffer.from(upload.contentSha256, 'hex').toString(
          'base64',
        ),
      }),
    );
  }

  /**
   * A short-lived read of a private object, with the filename a browser should save it
   * as and the spreadsheet content type. The TTL is decided by the caller because it
   * is capped by the result's remaining life, not by configuration alone.
   */
  async createDownloadUrl(input: {
    objectKey: string;
    jobId: string;
    ttlSeconds: number;
  }): Promise<string> {
    return this.translate(() =>
      this.storage.createPresignedGetUrl({
        objectKey: input.objectKey,
        ttlSeconds: input.ttlSeconds,
        downloadFilename: roomExportDownloadFilename(input.jobId),
        contentType: roomExportContentType,
      }),
    );
  }

  async delete(objectKey: string): Promise<void> {
    await this.translate(() =>
      this.storage.deleteObject({
        objectKey,
        timeoutMs: this.configuration.storage.timeoutMs,
      }),
    );
  }

  private async translate<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ObjectStorageUnavailableError) {
        throw roomExportErrors.storageUnavailable(error.cause ?? error);
      }
      throw error;
    }
  }
}

/** Hex, because that is what the job row stores and what an operator compares. */
export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}
