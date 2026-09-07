import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AmenityResponseDto, RoomTypeResponseDto } from './room-response.dto';

export class PublicRoomResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ type: RoomTypeResponseDto })
  roomType!: RoomTypeResponseDto;

  @ApiProperty({ minimum: 1, maximum: 20 })
  bedCount!: number;

  @ApiPropertyOptional({ nullable: true, example: 'CITY' })
  viewCode!: string | null;

  @ApiProperty({ maximum: Number.MAX_SAFE_INTEGER, example: 1500000 })
  basePriceAmount!: number;

  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({ type: [AmenityResponseDto] })
  amenities!: AmenityResponseDto[];

  @ApiPropertyOptional({
    description:
      'Present only when checkIn and checkOut were supplied. True when one active window contains the whole stay.',
  })
  available?: boolean;
}

export class PaginatedPublicRoomsResponseDto {
  @ApiProperty({ type: [PublicRoomResponseDto] })
  items!: PublicRoomResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
