import type { ExportJobStatus } from './entities/export-job.enums';

/** The projected job row, plus the database's own clock reading from the same query. */
export interface RoomExportJobView {
  id: string;
  status: ExportJobStatus;
  filters: Record<string, unknown>;
  objectKey: string | null;
  rowCount: number | null;
  fileSizeBytes: number | null;
  lastErrorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  databaseNow: Date;
}

export interface RoomExportDownloadTtl {
  /** Never longer than what remains of the result's life. */
  seconds: number;
  expiresAt: Date;
}
