import { createHash } from 'node:crypto';
import type { RoomCatalogFilterDto } from '../rooms/dto/room-catalog-filter.dto';
import { roomExportCreateOperation } from './room-export.constants';
import type {
  RoomExportCreateResponse,
  RoomExportFilters,
} from './room-export.types';

/**
 * Reduces the accepted body to the filters the admin catalogue would actually apply.
 *
 * A blank `query` is dropped rather than stored as an empty string, because the list
 * drops it too - `query.query?.trim()` there - and a filter that is present in the
 * snapshot but absent from the search would make two requests that mean the same
 * thing fingerprint differently, so one would replay and the other would not.
 *
 * `view`, `roomTypeId`, `beds` and `status` arrive already normalized by the shared
 * DTO, which is the point of sharing it.
 */
export function normalizeRoomExportFilters(
  body: RoomCatalogFilterDto,
): RoomExportFilters {
  const query = body.query?.trim();
  return {
    ...(query ? { query } : {}),
    ...(body.status ? { status: body.status } : {}),
    ...(body.roomTypeId ? { roomTypeId: body.roomTypeId } : {}),
    ...(body.beds === undefined ? {} : { beds: body.beds }),
    ...(body.view ? { view: body.view } : {}),
  };
}

/**
 * The digest an idempotency key is allowed to replay.
 *
 * Keys are emitted in a fixed order rather than in whichever order the request
 * happened to arrive in, so `{beds, view}` and `{view, beds}` are the same request.
 * The actor is inside the digest as well as in the unique key: it costs nothing and
 * means a fingerprint can never be interpreted against the wrong owner.
 */
export function roomExportCreateFingerprint(
  actorUserId: string,
  filters: RoomExportFilters,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        operation: roomExportCreateOperation,
        actorUserId,
        query: filters.query ?? null,
        status: filters.status ?? null,
        roomTypeId: filters.roomTypeId ?? null,
        beds: filters.beds ?? null,
        view: filters.view ?? null,
      }),
    )
    .digest('hex');
}

/**
 * Rebuilds the accepted response in one fixed key order.
 *
 * MySQL stores a JSON object in its own canonical order rather than the insertion
 * order, so a body read back from `idempotency_keys` serializes differently from the
 * one that was stored even though the values are identical. `SPEC-009` promises the
 * exact response on replay, and a client comparing raw bodies - or a signature over
 * them - would see two different strings. Every response therefore leaves through
 * here, fresh or replayed.
 */
export function toRoomExportCreateResponse(
  stored: RoomExportCreateResponse,
): RoomExportCreateResponse {
  return {
    id: stored.id,
    status: stored.status,
    createdAt: stored.createdAt,
    pollPath: stored.pollPath,
  };
}
