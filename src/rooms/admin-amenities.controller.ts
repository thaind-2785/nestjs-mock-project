import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.enums';
import { ReferenceCatalogQueryDto } from './dto/pagination-query.dto';
import {
  CreateAmenityDto,
  UpdateAmenityDto,
} from './dto/reference-catalog.dto';
import { AmenityIdParamDto } from './dto/room-id-param.dto';
import {
  AmenityResponseDto,
  PaginatedAmenitiesResponseDto,
} from './dto/room-response.dto';
import { ReferenceCatalogService } from './reference-catalog.service';

@ApiTags('Admin amenities')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/amenities')
export class AdminAmenitiesController {
  constructor(private readonly catalog: ReferenceCatalogService) {}

  @Post()
  @ApiCreatedResponse({ type: AmenityResponseDto })
  create(@Body() body: CreateAmenityDto): Promise<AmenityResponseDto> {
    return this.catalog.createAmenity(body);
  }

  @Get()
  @ApiOkResponse({ type: PaginatedAmenitiesResponseDto })
  list(
    @Query() query: ReferenceCatalogQueryDto,
  ): Promise<PaginatedAmenitiesResponseDto> {
    return this.catalog.listAmenities(query);
  }

  @Get(':amenityId')
  @ApiOkResponse({ type: AmenityResponseDto })
  get(@Param() params: AmenityIdParamDto): Promise<AmenityResponseDto> {
    return this.catalog.getAmenity(params.amenityId);
  }

  @Patch(':amenityId')
  @ApiOkResponse({ type: AmenityResponseDto })
  update(
    @Param() params: AmenityIdParamDto,
    @Body() body: UpdateAmenityDto,
  ): Promise<AmenityResponseDto> {
    return this.catalog.updateAmenity(params.amenityId, body);
  }

  @Delete(':amenityId')
  @HttpCode(204)
  @ApiNoContentResponse()
  delete(@Param() params: AmenityIdParamDto): Promise<void> {
    return this.catalog.deleteAmenity(params.amenityId);
  }
}
