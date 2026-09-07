import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  RoomStayQueryDto,
  SearchRoomsQueryDto,
} from './dto/public-room-query.dto';
import {
  PaginatedPublicRoomsResponseDto,
  PublicRoomResponseDto,
} from './dto/public-room-response.dto';
import { RoomIdParamDto } from './dto/room-id-param.dto';
import { RoomSearchService } from './room-search.service';

@ApiTags('Rooms')
@Public()
@Controller('rooms')
export class PublicRoomsController {
  constructor(private readonly roomSearch: RoomSearchService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedPublicRoomsResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'VALIDATION_FAILED, DATE_RANGE_INCOMPLETE, or STAY_RANGE_INVALID',
  })
  search(
    @Query() query: SearchRoomsQueryDto,
  ): Promise<PaginatedPublicRoomsResponseDto> {
    return this.roomSearch.search(query);
  }

  @Get(':roomId')
  @ApiOkResponse({ type: PublicRoomResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'VALIDATION_FAILED, DATE_RANGE_INCOMPLETE, or STAY_RANGE_INVALID',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'ROOM_NOT_FOUND',
  })
  get(
    @Param() params: RoomIdParamDto,
    @Query() query: RoomStayQueryDto,
  ): Promise<PublicRoomResponseDto> {
    return this.roomSearch.get(params.roomId, query);
  }
}
