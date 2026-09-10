import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  hotelDatePattern,
  hotelDateValidationOptions,
} from '../../common/constants/hotel-date.constants';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { BookingStatus } from '../entities/booking.enums';

export class UserBookingQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ format: 'date', example: '2026-10-01' })
  @ValidateIf((query: UserBookingQueryDto) => query.to !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  // The paired range is a report filter, so unlike booking create it may be past.
  // Strict parsing still rejects impossible calendar values at the HTTP boundary.
  @IsDateString(hotelDateValidationOptions)
  from?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-10-31' })
  @ValidateIf((query: UserBookingQueryDto) => query.from !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  to?: string;
}
