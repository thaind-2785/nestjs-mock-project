import { IntersectionType } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RoomCatalogFilterDto } from './room-catalog-filter.dto';

export class ListRoomsQueryDto extends IntersectionType(
  RoomCatalogFilterDto,
  PaginationQueryDto,
) {}
