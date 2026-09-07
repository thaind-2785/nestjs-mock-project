import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Deep pagination costs a large OFFSET scan, so the page number is bounded too. */
export const maxPageNumber = 10_000;

export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: maxPageNumber,
    default: 1,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(maxPageNumber)
  page = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 20,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class ReferenceCatalogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'deluxe' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}
