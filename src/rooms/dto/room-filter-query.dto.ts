import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trimAndUppercase } from './catalog-transforms';
import { decimalIdPattern } from './room-id-param.dto';

/**
 * Room attribute filters shared by the admin list and the public catalog so both
 * surfaces validate and normalize them identically.
 */
export class RoomAttributeFilterQueryDto {
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
