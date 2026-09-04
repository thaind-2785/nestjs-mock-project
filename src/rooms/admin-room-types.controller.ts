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
  CreateRoomTypeDto,
  UpdateRoomTypeDto,
} from './dto/reference-catalog.dto';
import { RoomTypeIdParamDto } from './dto/room-id-param.dto';
import {
  PaginatedRoomTypesResponseDto,
  RoomTypeResponseDto,
} from './dto/room-response.dto';
import { ReferenceCatalogService } from './reference-catalog.service';

@ApiTags('Admin room types')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/room-types')
export class AdminRoomTypesController {
  constructor(private readonly catalog: ReferenceCatalogService) {}

  @Post()
  @ApiCreatedResponse({ type: RoomTypeResponseDto })
  create(@Body() body: CreateRoomTypeDto): Promise<RoomTypeResponseDto> {
    return this.catalog.createRoomType(body);
  }

  @Get()
  @ApiOkResponse({ type: PaginatedRoomTypesResponseDto })
  list(
    @Query() query: ReferenceCatalogQueryDto,
  ): Promise<PaginatedRoomTypesResponseDto> {
    return this.catalog.listRoomTypes(query);
  }

  @Get(':roomTypeId')
  @ApiOkResponse({ type: RoomTypeResponseDto })
  get(@Param() params: RoomTypeIdParamDto): Promise<RoomTypeResponseDto> {
    return this.catalog.getRoomType(params.roomTypeId);
  }

  @Patch(':roomTypeId')
  @ApiOkResponse({ type: RoomTypeResponseDto })
  update(
    @Param() params: RoomTypeIdParamDto,
    @Body() body: UpdateRoomTypeDto,
  ): Promise<RoomTypeResponseDto> {
    return this.catalog.updateRoomType(params.roomTypeId, body);
  }

  @Delete(':roomTypeId')
  @HttpCode(204)
  @ApiNoContentResponse()
  delete(@Param() params: RoomTypeIdParamDto): Promise<void> {
    return this.catalog.deleteRoomType(params.roomTypeId);
  }
}
