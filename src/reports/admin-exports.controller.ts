import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import type { RequestWithContext } from '../common/http/request-context';
import { RoomCatalogFilterDto } from '../rooms/dto/room-catalog-filter.dto';
import { UserRole } from '../users/entities/user.enums';
import { CreateRoomExportResponseDto } from './dto/create-room-export-response.dto';
import { normalizeRoomExportFilters } from './room-export-create.helpers';
import { RoomExportCreateRateLimitGuard } from './room-export-create-rate-limit.guard';
import { RoomExportService } from './room-export.service';
import type { RoomExportCreateResponse } from './room-export.types';

@ApiTags('Admin exports')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/exports')
export class AdminExportsController {
  constructor(private readonly exports: RoomExportService) {}

  /**
   * The body is the admin catalogue's own filter contract, so pagination is not
   * "ignored" here - it is not part of the contract, and the global pipe rejects it
   * with the rest of the unknown fields.
   */
  @Post('rooms')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(RoomExportCreateRateLimitGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    example: 'room-export-2026-09-17',
  })
  @ApiAcceptedResponse({
    description: 'Accepts or replays one room export request.',
    type: CreateRoomExportResponseDto,
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'IDEMPOTENCY_KEY_INVALID or validation failure.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorResponseDto,
    description: 'EXPORT_CREATE_RATE_LIMITED.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'EXPORT_CREATE_DISABLED or EXPORT_CREATE_UNAVAILABLE.',
  })
  create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: RoomCatalogFilterDto,
    @Req() request: RequestWithContext,
  ): Promise<RoomExportCreateResponse> {
    return this.exports.create({
      // Server-derived, always. A requester the client could name would be a requester
      // the client could impersonate.
      actorUserId: principal.userId,
      idempotencyKey,
      filters: normalizeRoomExportFilters(body),
      requestId: request.requestId,
    });
  }
}
