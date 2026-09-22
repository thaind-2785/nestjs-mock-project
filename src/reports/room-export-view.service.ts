import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { reportsConfig } from '../config/reports.config';
import { toExportJobResponse } from './room-export-view.mapper';
import { downloadTtl, isDownloadable } from './room-export-view.policy';
import { RoomExportViewRepository } from './room-export-view.repository';
import { RoomExportStorageService } from './room-export-storage.service';
import { roomExportErrors } from './room-export.errors';
import type { ExportJobResponseDto } from './dto/export-job-response.dto';

/**
 * Answers one administrator's question about their own export.
 *
 * The order is deliberate: own it, then have a result, then still be in date, and only
 * then sign a URL. Each step is a reason the next one may not happen, and presigning
 * before any of them would produce a working URL for something the caller is not
 * entitled to.
 */
@Injectable()
export class RoomExportViewService {
  constructor(
    private readonly jobs: RoomExportViewRepository,
    private readonly storage: RoomExportStorageService,
    @Inject(reportsConfig.KEY)
    private readonly configuration: ConfigType<typeof reportsConfig>,
  ) {}

  async getOwned(
    jobId: string,
    requestedBy: string,
  ): Promise<ExportJobResponseDto> {
    const job = await this.jobs.findOwned(jobId, requestedBy);
    if (!job) throw roomExportErrors.notFound();
    if (!isDownloadable(job)) return toExportJobResponse(job);

    const ttl = downloadTtl(job, this.configuration.result.presignTtlSeconds);
    // A provider failure here does not change the job. The result is still complete and
    // still owned; a later poll may succeed, and mutating the row because a signature
    // could not be produced would turn an outage into data loss.
    const url = await this.storage.createDownloadUrl({
      objectKey: job.objectKey,
      jobId: job.id,
      ttlSeconds: ttl.seconds,
    });
    return toExportJobResponse(job, { url, expiresAt: ttl.expiresAt });
  }
}
