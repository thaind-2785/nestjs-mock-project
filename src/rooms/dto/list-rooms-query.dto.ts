import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
import { trimAndUppercase } from './catalog-transforms';
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

  // Normalize at the same boundary as writes; Swagger needs an explicit description.
  @ApiPropertyOptional({
    maxLength: 50,
    example: 'CITY',
    description:
      'Trimmed and uppercased before filtering; blank values omit the filter.',
  })
  @Transform(trimAndUppercase)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  view?: string;
}
