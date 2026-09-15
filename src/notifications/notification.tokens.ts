export const NOTIFICATION_QUEUE = Symbol('NOTIFICATION_QUEUE');

/**
 * The queue's Redis client, held separately because BullMQ treats a connection it
 * did not create as shared and so leaves it open when the queue closes. Without this
 * the worker keeps a live socket after shutdown and only `process.exit` ends it.
 */
export const NOTIFICATION_QUEUE_CLIENT = Symbol('NOTIFICATION_QUEUE_CLIENT');

/** The consumer's own blocking connection; BullMQ workers may not share one. */
export const NOTIFICATION_WORKER_CLIENT = Symbol('NOTIFICATION_WORKER_CLIENT');
