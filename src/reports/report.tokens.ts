/**
 * The export producer queue, or `null` while the export boundary is disabled.
 *
 * The token is always provided so the module graph is the same shape in both modes
 * and the difference is a value a consumer must handle, not a provider that may or
 * may not resolve.
 */
export const ROOM_EXPORT_QUEUE = Symbol('ROOM_EXPORT_QUEUE');

/**
 * The queue's Redis client, held separately because BullMQ treats a connection it did
 * not create as shared and leaves it open when the queue closes. Without this the
 * worker keeps a live socket after shutdown and only `process.exit` ends it.
 */
export const ROOM_EXPORT_QUEUE_CLIENT = Symbol('ROOM_EXPORT_QUEUE_CLIENT');

/** The consumer's own blocking connection; BullMQ workers may not share one. */
export const ROOM_EXPORT_WORKER_CLIENT = Symbol('ROOM_EXPORT_WORKER_CLIENT');
