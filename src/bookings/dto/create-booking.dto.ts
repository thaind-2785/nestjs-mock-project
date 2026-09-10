import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { decimalIdPattern } from '../../common/constants/identifier.constants';

const hotelDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export class CreateBookingDto {
  @ApiProperty({ example: '42' })
  @IsString()
  @Matches(decimalIdPattern)
  roomId!: string;

  @ApiProperty({ example: '2026-10-01' })
  @IsString()
  @Matches(hotelDatePattern)
  checkIn!: string;

  @ApiProperty({ example: '2026-10-04' })
  @IsString()
  @Matches(hotelDatePattern)
  checkOut!: string;
}
