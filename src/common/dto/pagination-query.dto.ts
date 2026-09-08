import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  defaultPageNumber,
  defaultPageSize,
  maxPageNumber,
  maxPageSize,
} from '../constants/pagination.constants';

/**
 * Every paginated list route in the project inherits these bounds, so page-size and
 * deep-offset limits cannot drift between modules or leave one list unbounded.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: maxPageNumber,
    default: defaultPageNumber,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(maxPageNumber)
  page = defaultPageNumber;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: maxPageSize,
    default: defaultPageSize,
    type: Number,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(maxPageSize)
  pageSize = defaultPageSize;
}
