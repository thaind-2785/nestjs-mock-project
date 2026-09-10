import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The public catalog owns its own response shapes. Reusing the admin DTOs would
 * publish their audit timestamps to anonymous callers and would silently expose
 * any field a later admin slice adds to them.
 */
export class PublicRoomTypeResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'Deluxe' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;
}

export class PublicAmenityResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: 'WIFI' })
  code!: string;

  @ApiProperty({ example: 'Wi-Fi' })
  name!: string;
}

/**
 * Public reads expose only the short-lived URL and its expiry: an anonymous caller
 * needs no attachment ID, object key, or upload metadata.
 */
export class PublicRoomImageResponseDto {
  @ApiProperty({ description: 'Short-lived presigned GET URL.' })
  url!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

export class PublicRoomResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ type: PublicRoomTypeResponseDto })
  roomType!: PublicRoomTypeResponseDto;

  @ApiProperty({ minimum: 1, maximum: 20 })
  bedCount!: number;

  @ApiPropertyOptional({ nullable: true, example: 'CITY' })
  viewCode!: string | null;

  @ApiProperty({ maximum: Number.MAX_SAFE_INTEGER, example: 1500000 })
  basePriceAmount!: number;

  @ApiProperty({ example: 'VND' })
  currency!: string;

  @ApiProperty({ type: [PublicAmenityResponseDto] })
  amenities!: PublicAmenityResponseDto[];

  @ApiPropertyOptional({ type: PublicRoomImageResponseDto, nullable: true })
  thumbnail!: PublicRoomImageResponseDto | null;

  @ApiPropertyOptional({
    type: [PublicRoomImageResponseDto],
    description:
      'Ordered album images. Present on room detail only; the list carries the thumbnail.',
  })
  images?: PublicRoomImageResponseDto[];

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
