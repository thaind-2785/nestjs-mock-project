import { SelectQueryBuilder } from 'typeorm';
import { RoomAttributeFilterQueryDto } from './dto/room-filter-query.dto';
import { Room } from './entities/room.entity';

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
