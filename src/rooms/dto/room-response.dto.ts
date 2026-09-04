import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoomStatus } from '../entities/room.enums';

export class RoomTypeResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'Deluxe' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class AmenityResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'WIFI' })
  code!: string;

  @ApiProperty({ example: 'Wi-Fi' })
  name!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class AdminRoomResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'A-201' })
  roomNumber!: string;

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

  @ApiProperty({ enum: RoomStatus })
  status!: RoomStatus;

  @ApiProperty({ type: [AmenityResponseDto] })
  amenities!: AmenityResponseDto[];

  @ApiProperty({ minimum: 1, example: 1 })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class PaginatedRoomTypesResponseDto {
  @ApiProperty({ type: [RoomTypeResponseDto] })
  items!: RoomTypeResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class PaginatedAmenitiesResponseDto {
  @ApiProperty({ type: [AmenityResponseDto] })
  items!: AmenityResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class PaginatedRoomsResponseDto {
  @ApiProperty({ type: [AdminRoomResponseDto] })
  items!: AdminRoomResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
