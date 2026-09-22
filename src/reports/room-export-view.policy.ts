import { ExportJobStatus } from './entities/export-job.enums';
import { RoomExportViewStatus } from './room-export-view.enums';
import type {
  RoomExportDownloadTtl,
  RoomExportJobView,
} from './room-export-view.types';

/**
 * What the requester is told this job is.
 *
 * `EXPIRED` is decided here rather than stored, against the database's own clock read
 * in the same query as the row. A completed result whose expiry has passed is expired
 * whether or not anything has deleted it yet - the API must not be the reason an
 * object outlives its lifetime.
 */
export function toViewStatus(job: RoomExportJobView): RoomExportViewStatus {
  if (job.status !== ExportJobStatus.Completed) {
    // The other three stored statuses are view statuses of the same name; only the
    // completed one can become something the table does not hold.
    return job.status as unknown as RoomExportViewStatus;
  }
  return hasExpired(job)
    ? RoomExportViewStatus.Expired
    : RoomExportViewStatus.Completed;
}

/**
 * The shortest lifetime an object store will sign. A URL's expiry is expressed in whole
 * seconds, so this is also the smallest amount of result life that can be handed out
 * without rounding it up.
 */
const minimumSignableSeconds = 1;

export function hasExpired(job: RoomExportJobView): boolean {
  if (job.expiresAt === null) return false;
  // The boundary has to belong to one side, and handing out a URL at the moment cleanup
  // is entitled to delete the object is the wrong side. So is the last fraction of a
  // second before it: a signed URL cannot live for less than a whole second, so a result
  // with 400 milliseconds left could only be signed for a URL that outlives it. A result
  // is therefore expired once it has less than one signable second remaining, which is
  // what lets `downloadTtl` round down without a floor that would undo the rounding.
  return (
    job.expiresAt.getTime() - job.databaseNow.getTime() <
    minimumSignableSeconds * 1_000
  );
}

/**
 * Whether this job can be presigned at all: completed, unexpired, and actually holding
 * the result metadata the workbook needs.
 *
 * The object key is checked as well as the status because they are written by the same
 * statement but read by a different process; trusting one to imply the other is a
 * belief about a transaction rather than about this row.
 */
export function isDownloadable(
  job: RoomExportJobView,
): job is RoomExportJobView & { objectKey: string; expiresAt: Date } {
  return (
    job.status === ExportJobStatus.Completed &&
    job.objectKey !== null &&
    job.expiresAt !== null &&
    !hasExpired(job)
  );
}

/**
 * How long the download URL may live: the configured lifetime, or whatever the result
 * has left, whichever is shorter.
 *
 * Without the cap, a job expiring in thirty seconds would still hand out a five-minute
 * URL - and that URL keeps working after the result is gone, because a presigned URL
 * is checked by the object store rather than by this application.
 */
export function downloadTtl(
  job: RoomExportJobView & { expiresAt: Date },
  configuredTtlSeconds: number,
): RoomExportDownloadTtl {
  const remainingMs = job.expiresAt.getTime() - job.databaseNow.getTime();
  // Rounded down, so the URL can never outlive the result by a fraction of a second.
  // There is no floor under this: `isDownloadable` has already refused anything with
  // less than one signable second left, so rounding down cannot reach zero here, and a
  // floor would be the one thing able to round a lifetime back up past the result's.
  const remainingSeconds = Math.floor(remainingMs / 1_000);
  const seconds = Math.min(configuredTtlSeconds, remainingSeconds);
  return {
    seconds,
    expiresAt: new Date(job.databaseNow.getTime() + seconds * 1_000),
  };
}
