import { ApiProperty } from '@nestjs/swagger';
import { BookingStatus } from '../../bookings/entities/booking.enums';
import { bookingStatsGroupings } from '../booking-stats.constants';
import type { BookingStatsGrouping } from '../booking-stats.types';

export class BookingStatsRevenueDto {
  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({
    example: 14_400_000,
    description: 'Integer minor units, as every other money field.',
  })
  amount!: number;
}

export class BookingStatsSummaryDto {
  @ApiProperty({ example: 12 })
  bookings!: number;

  @ApiProperty({
    description: 'Every booking status, zeros included.',
    type: 'object',
    properties: Object.fromEntries(
      Object.values(BookingStatus).map((status) => [
        status,
        { type: 'integer', example: 0 },
      ]),
    ),
  })
  byStatus!: Record<BookingStatus, number>;

  @ApiProperty({
    type: [BookingStatsRevenueDto],
    description:
      'Price snapshots of CONFIRMED and COMPLETED bookings, per currency and never converted.',
  })
  projectedRevenue!: BookingStatsRevenueDto[];
}

export class BookingStatsBucketDto extends BookingStatsSummaryDto {
  @ApiProperty({
    format: 'date',
    example: '2026-10-01',
    description: 'The day, or the first day of the month.',
  })
  period!: string;
}

export class BookingStatsResponseDto {
  @ApiProperty({ format: 'date', example: '2026-10-01' })
  from!: string;

  @ApiProperty({ format: 'date', example: '2026-11-01' })
  to!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  roomTypeId!: string | null;

  @ApiProperty({ enum: bookingStatsGroupings, nullable: true })
  groupBy!: BookingStatsGrouping | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-09-30T08:15:30.123Z',
    description:
      'When the newest applied booking change happened; null before the first. The report is eventually consistent.',
  })
  asOf!: string | null;

  @ApiProperty({ type: BookingStatsSummaryDto })
  totals!: BookingStatsSummaryDto;

  @ApiProperty({
    type: [BookingStatsBucketDto],
    description:
      'Only periods with bookings, ascending. Empty without groupBy.',
  })
  buckets!: BookingStatsBucketDto[];
}
