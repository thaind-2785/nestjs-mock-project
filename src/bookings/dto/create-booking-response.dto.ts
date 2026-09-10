import { ApiProperty } from '@nestjs/swagger';

class BookingRoomTypeResponseDto {
  @ApiProperty({ example: '7' })
  id!: string;

  @ApiProperty({ example: 'Deluxe' })
  name!: string;
}

class BookingRoomResponseDto {
  @ApiProperty({ example: '42' })
  id!: string;

  @ApiProperty({ example: 'A-201' })
  roomNumber!: string;

  @ApiProperty({ type: BookingRoomTypeResponseDto })
  roomType!: BookingRoomTypeResponseDto;
}

class BookingPriceResponseDto {
  @ApiProperty({ example: 4500000 })
  amount!: number;

  @ApiProperty({ example: 'VND' })
  currency!: string;
}

export class CreateBookingResponseDto {
  @ApiProperty({ example: '01K4N8G4X8R0K1F2Q7V6S9T3AB' })
  id!: string;

  @ApiProperty({ type: BookingRoomResponseDto })
  room!: BookingRoomResponseDto;

  @ApiProperty({ example: '2026-10-01' })
  checkIn!: string;

  @ApiProperty({ example: '2026-10-04' })
  checkOut!: string;

  @ApiProperty({ example: 3 })
  nights!: number;

  @ApiProperty({ enum: ['PENDING'] })
  status!: 'PENDING';

  @ApiProperty({ type: BookingPriceResponseDto })
  price!: BookingPriceResponseDto;

  @ApiProperty({ type: String, example: null, nullable: true })
  rejectionReason!: null;

  @ApiProperty({ example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
