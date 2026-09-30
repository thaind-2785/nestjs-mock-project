import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  hotelDatePattern,
  hotelDateValidationOptions,
} from '../../common/constants/hotel-date.constants';
import { decimalIdPattern } from '../../common/constants/identifier.constants';
import { bookingStatsGroupings } from '../booking-stats.constants';
import type { BookingStatsGrouping } from '../booking-stats.types';

/**
 * The report's filters. The span rule - `from` before `to`, at most a year - is checked
 * by the service, because it relates two fields and has its own stable error code.
 */
export class BookingStatsQueryDto {
  @ApiProperty({
    format: 'date',
    example: '2026-10-01',
    description: 'First stay check-in date included.',
  })
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  from!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-11-01',
    description: 'First stay check-in date excluded.',
  })
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  to!: string;

  @ApiPropertyOptional({ pattern: decimalIdPattern.source })
  @IsOptional()
  @IsString()
  @Matches(decimalIdPattern)
  roomTypeId?: string;

  @ApiPropertyOptional({ enum: bookingStatsGroupings })
  @IsOptional()
  @IsIn(bookingStatsGroupings)
  groupBy?: BookingStatsGrouping;
}
