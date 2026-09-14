import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  hotelDatePattern,
  hotelDateValidationOptions,
} from '../../common/constants/hotel-date.constants';
import { decimalIdPattern } from '../../common/constants/identifier.constants';

export class UpdateBookingDto {
  @ApiPropertyOptional({ pattern: decimalIdPattern.source })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(decimalIdPattern)
  roomId?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  checkIn?: string;
  @ApiPropertyOptional({ format: 'date' })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  checkOut?: string;
  @ApiProperty({ minLength: 1, maxLength: 1000 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
