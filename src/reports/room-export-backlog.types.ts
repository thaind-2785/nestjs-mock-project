import type { ExportJobStatus } from './entities/export-job.enums';

export interface RoomExportOutboxBacklog {
  status: string;
  count: number;
  /** Zero unless the group is `PENDING`; a terminal group has nothing overdue. */
  oldestAvailableAgeMs: number;
}

export interface RoomExportLeaseBacklog {
  /** Claimed and still being worked on, as far as the lease knows. */
  liveCount: number;
  /** Claimed by something that stopped. Recoverable, but nobody has yet. */
  expiredCount: number;
  oldestExpiredAgeMs: number;
}

export interface RoomExportJobBacklog {
  status: ExportJobStatus;
  count: number;
}

export interface RoomExportFailureGroup {
  errorCode: string;
  count: number;
}

export interface RoomExportSafeguardBacklog {
  /** Uploads whose attempt never finalized. Each one is an object nobody points at. */
  dueCount: number;
  oldestDueAgeMs: number;
}

export interface RoomExportQueueBacklog {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface RoomExportBacklogSnapshot {
  outbox: RoomExportOutboxBacklog[];
  leases: RoomExportLeaseBacklog;
  jobs: RoomExportJobBacklog[];
  failures: RoomExportFailureGroup[];
  safeguards: RoomExportSafeguardBacklog;
}
