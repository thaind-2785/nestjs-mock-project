import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { RoomStatus } from '../entities/room.enums';
import { PaginationQueryDto } from './pagination-query.dto';
import { decimalIdPattern } from './room-id-param.dto';

export class ListRoomsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'A-2' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;

  @ApiPropertyOptional({ enum: RoomStatus })
  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @ApiPropertyOptional({ example: '1', pattern: decimalIdPattern.source })
  @IsOptional()
  @IsString()
  @Matches(decimalIdPattern)
  roomTypeId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  beds?: number;

  @ApiPropertyOptional({ maxLength: 50, example: 'CITY' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  view?: string;
}
