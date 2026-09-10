import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBookingResponseDto } from './create-booking-response.dto';
import { BookingActorType, BookingStatus } from '../entities/booking.enums';

class BookingHistoryActorResponseDto {
  @ApiProperty({ example: '42' })
  id!: string;

  @ApiProperty({ example: 'Booking User' })
  displayName!: string;
}

class UserBookingHistoryResponseDto {
  @ApiProperty({ enum: BookingStatus, nullable: true })
  fromStatus!: BookingStatus | null;

  @ApiProperty({ enum: BookingStatus })
  toStatus!: BookingStatus;

  @ApiProperty({ enum: BookingActorType })
  actorType!: BookingActorType;

  @ApiPropertyOptional({ type: BookingHistoryActorResponseDto })
  actor?: BookingHistoryActorResponseDto;

  @ApiProperty({ nullable: true, example: null })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class UserBookingResponseDto extends CreateBookingResponseDto {
  @ApiProperty({ enum: BookingStatus })
  declare status: BookingStatus;

  @ApiProperty({ nullable: true, type: String })
  declare rejectionReason: string | null;
}

export class UserBookingDetailResponseDto extends UserBookingResponseDto {
  @ApiProperty({ type: [UserBookingHistoryResponseDto] })
  history!: UserBookingHistoryResponseDto[];
}

export class PaginatedUserBookingsResponseDto {
  @ApiProperty({ type: [UserBookingResponseDto] })
  items!: UserBookingResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 1 })
  total!: number;
}
