import { RoomExportViewStatus } from './room-export-view.enums';
import { toViewStatus } from './room-export-view.policy';
import type { ExportJobResponseDto } from './dto/export-job-response.dto';
import type { RoomExportJobView } from './room-export-view.types';

/**
 * Builds the poll response, field by field, from what the state actually justifies.
 *
 * Fields are added rather than nulled out, because "omitted" and "null" say different
 * things and only one of them is true: a queued job has no completion time, it does
 * not have a completion time of null. The object key and the content hash appear
 * nowhere at any status - the key is the only thing between a presigned URL and the
 * bucket, and it is server-generated precisely so a client never sees it.
 */
export function toExportJobResponse(
  job: RoomExportJobView,
  download?: { url: string; expiresAt: Date },
): ExportJobResponseDto {
  const status = toViewStatus(job);
  const response: ExportJobResponseDto = {
    id: job.id,
    status,
    filters: job.filters,
    createdAt: job.createdAt.toISOString(),
  };
  if (job.startedAt) response.startedAt = job.startedAt.toISOString();

  if (status === RoomExportViewStatus.Failed) {
    // A failure carries its stable code and nothing else. No partial result metadata,
    // because there is no partial result: the job row's check constraint forbids one.
    if (job.lastErrorCode) response.errorCode = job.lastErrorCode;
    return response;
  }

  if (
    status === RoomExportViewStatus.Completed ||
    status === RoomExportViewStatus.Expired
  ) {
    if (job.completedAt) response.completedAt = job.completedAt.toISOString();
    if (job.expiresAt) response.expiresAt = job.expiresAt.toISOString();
    if (job.rowCount !== null) response.rowCount = job.rowCount;
    if (job.fileSizeBytes !== null) response.fileSizeBytes = job.fileSizeBytes;
  }
  // Only a live download produces a URL. An expired result keeps its metadata, which
  // is how a requester learns their export existed and when it lapsed, and loses the
  // only field that would still work.
  if (download) {
    response.download = {
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
    };
  }
  return response;
}
