import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { maxAmenityFilterCount } from '../room-search-policy';
import { IsCurrencyCode } from './currency-code.decorator';
import { hotelDatePattern, hotelDateValidationOptions } from './hotel-date';
import { PaginationQueryDto } from './pagination-query.dto';
import { RoomAttributeFilterQueryDto } from './room-filter-query.dto';
import { decimalIdPattern } from './room-id-param.dto';

/**
 * Express exposes a single repeated parameter as a scalar. Deduplicate here so the
 * cardinality cap measures the effective filter: a checkbox UI that resubmits the
 * same amenity many times asks for one amenity, not many.
 */
const toDistinctArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  return [...new Set(Array.isArray(value) ? value : [value])];
};

export class RoomStayQueryDto {
  @ApiPropertyOptional({ format: 'date', example: '2026-10-05' })
  @IsOptional()
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  checkIn?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-10-08' })
  @IsOptional()
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  checkOut?: string;
}

// The stay pair is validated identically on both public routes, so the search
// query is the paginated intersection of it rather than a second copy.
export class SearchRoomsQueryDto extends IntersectionType(
  RoomStayQueryDto,
  RoomAttributeFilterQueryDto,
  PaginationQueryDto,
) {
  @ApiPropertyOptional({
    type: [String],
    maxItems: maxAmenityFilterCount,
    description:
      'Repeatable amenity ID. A room must have every requested amenity.',
  })
  @Transform(toDistinctArray)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maxAmenityFilterCount)
  @IsString({ each: true })
  @Matches(decimalIdPattern, { each: true })
  amenity?: string[];

  @ApiPropertyOptional({ minimum: 0, type: Number, example: 1000000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  minPrice?: number;

  @ApiPropertyOptional({ minimum: 0, type: Number, example: 2000000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  maxPrice?: number;

  // Phase 3 performs no conversion, so a price bound is meaningless without the
  // currency it is expressed in.
  @ApiPropertyOptional({
    example: 'VND',
    description: 'Required when minPrice or maxPrice is supplied.',
  })
  @ValidateIf(
    (query: SearchRoomsQueryDto, value: unknown) =>
      value !== undefined ||
      query.minPrice !== undefined ||
      query.maxPrice !== undefined,
  )
  @IsCurrencyCode()
  currency?: string;
}
