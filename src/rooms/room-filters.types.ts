import type { RoomStatus } from './entities/room.enums';

/**
 * The filters the admin catalogue applies, independent of how they arrived.
 *
 * The admin list receives them as a query string and the room export as a stored JSON
 * snapshot, so the shared helper takes this rather than either DTO: a stored filter set
 * read back from `export_jobs` is not a validated request object and should not have to
 * pretend to be one.
 */
export interface RoomCatalogFilters {
  query?: string;
  status?: RoomStatus;
  roomTypeId?: string;
  beds?: number;
  view?: string;
}
