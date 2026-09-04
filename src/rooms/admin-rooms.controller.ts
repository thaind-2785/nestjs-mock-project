import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.enums';
import { ListRoomsQueryDto } from './dto/list-rooms-query.dto';
import { RoomIdParamDto } from './dto/room-id-param.dto';
import { CreateRoomDto, UpdateRoomDto } from './dto/room-request.dto';
import {
  AdminRoomResponseDto,
  PaginatedRoomsResponseDto,
} from './dto/room-response.dto';
import { parseRoomVersionHeader } from './room-version';
import { RoomsService } from './rooms.service';

@ApiTags('Admin rooms')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/rooms')
export class AdminRoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Post()
  @ApiCreatedResponse({ type: AdminRoomResponseDto })
  create(@Body() body: CreateRoomDto): Promise<AdminRoomResponseDto> {
    return this.rooms.create(body);
  }

  @Get()
  @ApiOkResponse({ type: PaginatedRoomsResponseDto })
  list(@Query() query: ListRoomsQueryDto): Promise<PaginatedRoomsResponseDto> {
    return this.rooms.list(query);
  }

  @Get(':roomId')
  @ApiOkResponse({ type: AdminRoomResponseDto })
  get(@Param() params: RoomIdParamDto): Promise<AdminRoomResponseDto> {
    return this.rooms.get(params.roomId);
  }

  @Patch(':roomId')
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'Quoted room version returned by the latest admin read.',
    example: '"1"',
  })
  @ApiOkResponse({ type: AdminRoomResponseDto })
  update(
    @Param() params: RoomIdParamDto,
    @Headers('if-match') versionHeader: string | undefined,
    @Body() body: UpdateRoomDto,
  ): Promise<AdminRoomResponseDto> {
    return this.rooms.update(
      params.roomId,
      parseRoomVersionHeader(versionHeader),
      body,
    );
  }

  @Delete(':roomId')
  @HttpCode(204)
  @ApiNoContentResponse()
  delete(@Param() params: RoomIdParamDto): Promise<void> {
    return this.rooms.delete(params.roomId);
  }
}
