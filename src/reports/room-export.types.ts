import type { RoomStatus } from '../rooms/entities/room.enums';
import type { ExportJobStatus } from './entities/export-job.enums';

/**
 * The normalized filter snapshot. It is written once into the job row, fingerprinted
 * for idempotency, and read back by the worker; it is never re-derived from a later
 * request, so an administrator who changes their mind gets a new job rather than a
 * different answer from the one they already asked for.
 */
export interface RoomExportFilters {
  query?: string;
  status?: RoomStatus;
  roomTypeId?: string;
  beds?: number;
  view?: string;
}

export interface RoomExportCreateInput {
  actorUserId: string;
  idempotencyKey: string | undefined;
  filters: RoomExportFilters;
  requestId?: string;
}

/** The stored `202` body, byte for byte what a replay returns. */
export interface RoomExportCreateResponse {
  id: string;
  status: ExportJobStatus;
  createdAt: string;
  pollPath: string;
}

export interface RoomExportCreateResult {
  response: RoomExportCreateResponse;
  replayed: boolean;
}

export interface CreatedRoomExportJob {
  id: string;
  createdAt: Date;
}
