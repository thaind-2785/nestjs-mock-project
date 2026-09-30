import { Controller, Get, Header, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { UserRole } from '../users/entities/user.enums';
import { BookingStatsReportService } from './booking-stats-report.service';
import { BookingStatsQueryDto } from './dto/booking-stats-query.dto';
import { BookingStatsResponseDto } from './dto/booking-stats-response.dto';

@ApiTags('Admin reports')
@ApiBearerAuth()
@Roles(UserRole.Admin)
@Controller('admin/reports')
export class AdminBookingStatsController {
  constructor(private readonly reports: BookingStatsReportService) {}

  /** `no-store` because the numbers move with every applied booking change. */
  @Get('booking-stats')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({
    description:
      'Counts per status and projected revenue per currency for bookings whose stay check-in date is in [from, to).',
    type: BookingStatsResponseDto,
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'VALIDATION_FAILED or BOOKING_STATS_RANGE_INVALID.',
  })
  @ApiResponse({
    status: 422,
    type: ErrorResponseDto,
    description: 'BOOKING_STATS_AMOUNT_OUT_OF_RANGE.',
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: 'BOOKING_STATS_DISABLED while the stream is off.',
  })
  get(@Query() query: BookingStatsQueryDto): Promise<BookingStatsResponseDto> {
    return this.reports.report(query);
  }
}
