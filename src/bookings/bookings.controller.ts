import {
  Body,
  Controller,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import type { RequestWithContext } from '../common/http/request-context';
import { UserRole } from '../users/entities/user.enums';
import { BookingCreateRateLimitGuard } from './booking-create-rate-limit.guard';
import { BookingCreateResponse } from './booking-create.types';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CreateBookingResponseDto } from './dto/create-booking-response.dto';

@ApiTags('Bookings')
@ApiBearerAuth()
@Roles(UserRole.User)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @UseGuards(BookingCreateRateLimitGuard)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    example: 'booking-create-2026-10-01',
  })
  @ApiCreatedResponse({
    description: 'Creates or replays one pending booking.',
    type: CreateBookingResponseDto,
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description:
      'IDEMPOTENCY_KEY_INVALID, BOOKING_STAY_INVALID, or validation failure.',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'ROOM_NOT_FOUND.',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'IDEMPOTENCY_KEY_REUSED or BOOKING_WINDOW_UNAVAILABLE.',
  })
  @ApiResponse({
    status: 422,
    type: ErrorResponseDto,
    description: 'BOOKING_PRICE_OUT_OF_RANGE.',
  })
  @ApiResponse({
    status: 429,
    type: ErrorResponseDto,
    description: 'BOOKING_CREATE_RATE_LIMITED.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'BOOKING_CREATE_UNAVAILABLE or DATABASE_OVERLOADED.',
  })
  create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateBookingDto,
    @Req() request: RequestWithContext,
  ): Promise<BookingCreateResponse> {
    return this.bookings.create(
      principal.userId,
      idempotencyKey,
      body,
      request.requestId,
    );
  }
}
