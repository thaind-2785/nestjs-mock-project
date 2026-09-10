import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
}
