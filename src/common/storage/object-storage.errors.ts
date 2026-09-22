/**
 * One provider-neutral failure. Callers map it to their own stable error, because an
 * attachment upload and an export upload fail for the same reason and answer for
 * different ones - and because a shared adapter has no business knowing which HTTP
 * status a given feature returns.
 */
export class ObjectStorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Object storage is unavailable', { cause });
    this.name = 'ObjectStorageUnavailableError';
  }
}
