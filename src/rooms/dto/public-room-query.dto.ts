import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { maxAmenityFilterCount } from '../room-search-policy';
import { trimAndUppercase } from './catalog-transforms';
import { hotelDatePattern, hotelDateValidationOptions } from './hotel-date';
import { PaginationQueryDto } from './pagination-query.dto';
import { decimalIdPattern } from './room-id-param.dto';

// Express exposes a single repeated parameter as a scalar; normalize before validating.
const toArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
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

export class SearchRoomsQueryDto extends PaginationQueryDto {
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

  @ApiPropertyOptional({
    type: [String],
    maxItems: maxAmenityFilterCount,
    description:
      'Repeatable amenity ID. A room must have every requested amenity.',
  })
  @Transform(toArray)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(maxAmenityFilterCount)
  @IsString({ each: true })
  @Matches(decimalIdPattern, { each: true })
  amenity?: string[];

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
  @Transform(trimAndUppercase)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  view?: string;

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
  @Transform(trimAndUppercase)
  @ValidateIf(
    (query: SearchRoomsQueryDto, value: unknown) =>
      value !== undefined ||
      query.minPrice !== undefined ||
      query.maxPrice !== undefined,
  )
  @IsString()
  @IsISO4217CurrencyCode()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
