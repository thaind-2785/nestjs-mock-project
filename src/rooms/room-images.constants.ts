/**
 * Bounds the reorder payload before any database work. The album count limit is
 * configuration, so this cap only has to be at least as large as any configured
 * album; the service still rejects a list that is not exactly the current album.
 */
export const maxRoomImageOrderSize = 100;
