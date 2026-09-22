import { SelectQueryBuilder } from 'typeorm';
import { RoomAttributeFilterQueryDto } from './dto/room-filter-query.dto';
import type { RoomCatalogFilters } from './room-filters.types';
import { Room } from './entities/room.entity';

/**
 * Every filter the admin catalogue understands, applied once.
 *
 * The admin list and the room export must select the same rooms for the same filters,
 * or a workbook answers a different question than the screen it was requested from.
 * That is a property rather than a promise only while there is one implementation of
 * the search term, and the term is the part that would drift: the `LIKE` shape, the
 * escape character, the lowercasing, and which columns it spans are four independent
 * chances to differ.
 */
export function applyRoomCatalogFilters(
  builder: SelectQueryBuilder<Room>,
  filters: RoomCatalogFilters,
): void {
  const term = filters.query?.trim();
  if (term) {
    builder.andWhere(
      "(LOWER(room.room_number) LIKE :term ESCAPE '\\\\' OR LOWER(roomType.name) LIKE :term ESCAPE '\\\\')",
      { term: `%${escapeLike(term.toLowerCase())}%` },
    );
  }
  if (filters.status) {
    builder.andWhere('room.status = :status', { status: filters.status });
  }
  applyRoomAttributeFilters(builder, filters);
}

/**
 * `%` and `_` are wildcards and `\` is the escape character, so a guest searching for
 * `A_1` must not match `A-1`. Escaping happens here rather than at the call site
 * because a caller that forgot would produce a query that works and is wrong.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Room attribute filters shared by the admin list and the public catalog. Keeping
 * one implementation means a fix to ordering, parameter names, or blank handling
 * cannot apply to only one of the two surfaces.
 */
export function applyRoomAttributeFilters(
  builder: SelectQueryBuilder<Room>,
  query: RoomAttributeFilterQueryDto,
): void {
  if (query.roomTypeId) {
    builder.andWhere('room.room_type_id = :roomTypeId', {
      roomTypeId: query.roomTypeId,
    });
  }
  if (query.beds !== undefined) {
    builder.andWhere('room.bed_count = :beds', { beds: query.beds });
  }
  if (query.view) {
    builder.andWhere('room.view_code = :view', { view: query.view });
  }
}
