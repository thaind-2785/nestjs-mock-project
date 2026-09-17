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
