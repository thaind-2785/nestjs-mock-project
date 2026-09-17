/**
 * The one export event family. It is a durable contract: rows carrying it already
 * exist in `outbox_events` once a job is created, so renaming it is a migration
 * rather than a refactor.
 */
export const roomExportEventType = 'room-export.requested';

/**
 * The export dispatcher's claim allowlist.
 *
 * Two independent consumers now read one outbox table, and event-type filtering
 * belongs inside the claiming statement, before `LIMIT`. Filtering after a claim is
 * not the same thing: the wrong dispatcher would already hold the lease and the row
 * would be unavailable to its real owner until that lease expired.
 */
export const roomExportEventTypes = [roomExportEventType] as const;

export type RoomExportEventType = (typeof roomExportEventTypes)[number];

/** The `idempotency_keys.operation` namespace for export creation. */
export const roomExportCreateOperation = 'ROOM_EXPORT_CREATE';

/** The schema version carried by every `room-export.requested` payload. */
export const roomExportEventSchemaVersion = 1;

/** Where a requester polls the job, returned in the accepted response. */
export const roomExportPollPathPrefix = '/api/v1/admin/exports';
