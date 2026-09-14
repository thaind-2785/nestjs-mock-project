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
import { decimalIdPattern } from '../../common/constants/identifier.constants';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { BookingStatus } from '../entities/booking.enums';

export class AdminBookingQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf((query: AdminBookingQueryDto) => query.to !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  from?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf((query: AdminBookingQueryDto) => query.from !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  to?: string;
  @ApiPropertyOptional({ pattern: decimalIdPattern.source })
  @IsOptional()
  @IsString()
  @Matches(decimalIdPattern)
  roomId?: string;
  @ApiPropertyOptional({ pattern: decimalIdPattern.source })
  @IsOptional()
  @IsString()
  @Matches(decimalIdPattern)
  roomTypeId?: string;
  @ApiPropertyOptional({ pattern: decimalIdPattern.source })
  @IsOptional()
  @IsString()
  @Matches(decimalIdPattern)
  userId?: string;
}
