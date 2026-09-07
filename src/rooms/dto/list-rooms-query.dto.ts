import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { RoomStatus } from '../entities/room.enums';
import { PaginationQueryDto } from './pagination-query.dto';
import { RoomAttributeFilterQueryDto } from './room-filter-query.dto';

export class ListRoomsQueryDto extends IntersectionType(
  RoomAttributeFilterQueryDto,
  PaginationQueryDto,
) {
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
