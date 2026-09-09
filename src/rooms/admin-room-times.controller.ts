import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { UserRole } from '../users/entities/user.enums';
import { RoomIdParamDto, RoomTimeIdParamDto } from './dto/room-id-param.dto';
import {
  CreateRoomTimeDto,
  UpdateRoomTimeDto,
} from './dto/room-time-request.dto';
import { AdminRoomTimeResponseDto } from './dto/room-time-response.dto';
import { RoomTimesService } from './room-times.service';

@ApiTags('Admin room times')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/rooms/:roomId/times')
export class AdminRoomTimesController {
  constructor(private readonly roomTimes: RoomTimesService) {}

  @Post()
  @ApiCreatedResponse({ type: AdminRoomTimeResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'VALIDATION_FAILED or ROOM_TIME_RANGE_INVALID',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'ROOM_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'ROOM_TIME_OVERLAP',
  })
  create(
    @Param() params: RoomIdParamDto,
    @Body() body: CreateRoomTimeDto,
  ): Promise<AdminRoomTimeResponseDto> {
    return this.roomTimes.create(params.roomId, body);
  }

  @Get()
  @ApiOkResponse({ type: AdminRoomTimeResponseDto, isArray: true })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'VALIDATION_FAILED',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'ROOM_NOT_FOUND',
  })
  list(@Param() params: RoomIdParamDto): Promise<AdminRoomTimeResponseDto[]> {
    return this.roomTimes.list(params.roomId);
  }

  @Patch(':roomTimeId')
  @ApiOkResponse({ type: AdminRoomTimeResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'VALIDATION_FAILED or ROOM_TIME_RANGE_INVALID',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'ROOM_NOT_FOUND or ROOM_TIME_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description:
      'ROOM_TIME_OVERLAP, ROOM_TIME_DATES_IMMUTABLE, or ROOM_TIME_IN_USE',
  })
  update(
    @Param() params: RoomTimeIdParamDto,
    @Body() body: UpdateRoomTimeDto,
  ): Promise<AdminRoomTimeResponseDto> {
    return this.roomTimes.update(params.roomId, params.roomTimeId, body);
  }

  @Delete(':roomTimeId')
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'VALIDATION_FAILED',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'ROOM_NOT_FOUND or ROOM_TIME_NOT_FOUND',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'ROOM_TIME_HAS_HISTORY',
  })
  delete(@Param() params: RoomTimeIdParamDto): Promise<void> {
    return this.roomTimes.delete(params.roomId, params.roomTimeId);
  }
}
