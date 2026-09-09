import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ReferenceCatalogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 100, example: 'deluxe' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}
