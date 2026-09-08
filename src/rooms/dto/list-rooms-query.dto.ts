import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RoomStatus } from '../entities/room.enums';
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
