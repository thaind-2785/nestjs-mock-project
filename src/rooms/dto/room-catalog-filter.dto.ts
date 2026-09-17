import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RoomStatus } from '../entities/room.enums';
import { RoomAttributeFilterQueryDto } from './room-filter-query.dto';

/**
 * Every filter the admin catalogue understands, and no pagination.
 *
 * The admin list is this plus a page; the room export is this exactly. Keeping the
 * two surfaces on one contract is what makes "the export returns what the list shows"
 * a property rather than a claim - a filter added to one and not the other would
 * silently produce a workbook that answers a different question than the screen the
 * administrator was looking at.
 */
export class RoomCatalogFilterDto extends RoomAttributeFilterQueryDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'A-2' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;

  @ApiPropertyOptional({ enum: RoomStatus })
  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;
}
