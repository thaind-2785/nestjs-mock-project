import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  UserBookingDetailResponseDto,
  UserBookingResponseDto,
} from './user-booking-response.dto';
import { UserStatus } from '../../users/entities/user.enums';

class AdminBookingOwnerResponseDto {
  @ApiProperty({ example: '42' }) id!: string;
  @ApiProperty({ example: 'guest@example.com' }) email!: string;
  @ApiProperty({ example: 'Guest' }) displayName!: string;
  @ApiProperty({ enum: UserStatus }) status!: UserStatus;
}

class AdminBookingChangeEndpointDto {
  @ApiProperty({ example: '1' }) roomId!: string;
  @ApiProperty({ format: 'date' }) checkIn!: string;
  @ApiProperty({ format: 'date' }) checkOut!: string;
}

class AdminBookingChangeResponseDto {
  @ApiProperty({ type: AdminBookingOwnerResponseDto }) actor!: Pick<
    AdminBookingOwnerResponseDto,
    'id' | 'displayName'
  >;
  @ApiProperty({ type: AdminBookingChangeEndpointDto })
  from!: AdminBookingChangeEndpointDto;
  @ApiProperty({ type: AdminBookingChangeEndpointDto })
  to!: AdminBookingChangeEndpointDto;
  @ApiProperty() reason!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AdminBookingResponseDto extends UserBookingResponseDto {
  @ApiProperty({ type: AdminBookingOwnerResponseDto })
  owner!: AdminBookingOwnerResponseDto;
}

export class AdminBookingDetailResponseDto extends UserBookingDetailResponseDto {
  @ApiProperty({ type: AdminBookingOwnerResponseDto })
  owner!: AdminBookingOwnerResponseDto;
  @ApiPropertyOptional({ type: [AdminBookingChangeResponseDto] })
  changes!: AdminBookingChangeResponseDto[];
}

export class PaginatedAdminBookingsResponseDto {
  @ApiProperty({ type: [AdminBookingResponseDto] })
  items!: AdminBookingResponseDto[];
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) pageSize!: number;
  @ApiProperty({ example: 1 }) total!: number;
}
