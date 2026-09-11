import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import type { RequestWithContext } from '../common/http/request-context';
import { UserRole } from '../users/entities/user.enums';
import { BookingsService } from './bookings.service';
import { AdminBookingQueryDto } from './dto/admin-booking-query.dto';
import { BookingIdParamDto } from './dto/booking-id-param.dto';
import {
  AdminBookingDetailResponseDto,
  PaginatedAdminBookingsResponseDto,
} from './dto/admin-booking-response.dto';
import { RejectBookingDto } from './dto/reject-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { parseBookingVersionHeader } from './booking-version';
import {
  AdminBookingDetailResponse,
  PaginatedAdminBookingsResponse,
} from './admin-booking.types';

@ApiTags('Admin bookings')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/bookings')
export class AdminBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedAdminBookingsResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  list(
    @Query() query: AdminBookingQueryDto,
  ): Promise<PaginatedAdminBookingsResponse> {
    return this.bookings.listAdmin(query);
  }

  @Get(':bookingId')
  @ApiOkResponse({ type: AdminBookingDetailResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'BOOKING_NOT_FOUND.',
  })
  detail(
    @Param() params: BookingIdParamDto,
  ): Promise<AdminBookingDetailResponse> {
    return this.bookings.getAdmin(params.bookingId);
  }

  @Post(':bookingId/approve')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminBookingDetailResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'BOOKING_NOT_FOUND.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description:
      'BOOKING_STATE_CHANGED, BOOKING_STATUS_CONFLICT, BOOKING_WINDOW_UNAVAILABLE, or ROOM_ALREADY_BOOKED.',
  })
  approve(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() params: BookingIdParamDto,
    @Req() request: RequestWithContext,
  ): Promise<AdminBookingDetailResponse> {
    return this.bookings.approve({
      actorUserId: principal.userId,
      bookingPublicId: params.bookingId,
      requestId: request.requestId,
    });
  }

  @Post(':bookingId/reject')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminBookingDetailResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'BOOKING_NOT_FOUND.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'BOOKING_STATUS_CONFLICT.',
  })
  reject(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() params: BookingIdParamDto,
    @Body() body: RejectBookingDto,
    @Req() request: RequestWithContext,
  ): Promise<AdminBookingDetailResponse> {
    return this.bookings.reject({
      actorUserId: principal.userId,
      bookingPublicId: params.bookingId,
      reason: body.reason,
      requestId: request.requestId,
    });
  }

  @Patch(':bookingId')
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description:
      'One quoted positive decimal booking version (1-20 digits). Wildcards, weak tags, and tag lists are unsupported.',
    example: '"1"',
  })
  @ApiOkResponse({ type: AdminBookingDetailResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'BOOKING_VERSION_MALFORMED, BOOKING_CHANGE_EMPTY, or VALIDATION_FAILED.',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'BOOKING_NOT_FOUND or ROOM_NOT_FOUND.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description:
      'BOOKING_STATE_CHANGED, BOOKING_STATUS_CONFLICT, BOOKING_WINDOW_UNAVAILABLE, or ROOM_ALREADY_BOOKED.',
  })
  @ApiResponse({
    status: 412,
    type: ErrorResponseDto,
    description:
      'BOOKING_VERSION_CONFLICT: read the current booking before retrying.',
  })
  @ApiResponse({
    status: 428,
    type: ErrorResponseDto,
    description: 'BOOKING_VERSION_REQUIRED: missing or empty If-Match.',
  })
  update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() params: BookingIdParamDto,
    @Headers('if-match') versionHeader: string | undefined,
    @Body() body: UpdateBookingDto,
    @Req() request: RequestWithContext,
  ): Promise<AdminBookingDetailResponse> {
    return this.bookings.updateAdmin({
      actorUserId: principal.userId,
      bookingPublicId: params.bookingId,
      expectedVersion: parseBookingVersionHeader(versionHeader),
      body,
      requestId: request.requestId,
    });
  }

  @Post(':bookingId/cancel')
  @HttpCode(200)
  @ApiOkResponse({ type: AdminBookingDetailResponseDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'VALIDATION_FAILED: the reason is missing, blank, or too long.',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'BOOKING_NOT_FOUND.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description:
      'BOOKING_STATUS_CONFLICT: terminal status, or a retry with a different reason.',
  })
  cancel(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param() params: BookingIdParamDto,
    @Body() body: CancelBookingDto,
    @Req() request: RequestWithContext,
  ): Promise<AdminBookingDetailResponse> {
    return this.bookings.cancelAdmin({
      actorUserId: principal.userId,
      bookingPublicId: params.bookingId,
      reason: body.reason,
      requestId: request.requestId,
    });
  }
}
