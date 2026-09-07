import { ApiProperty } from '@nestjs/swagger';
import { RoomTimeStatus } from '../entities/room.enums';

export class RoomTimeUsageResponseDto {
  @ApiProperty({ minimum: 0, example: 0 })
  bookingCount!: number;

  @ApiProperty({ minimum: 0, example: 0 })
  activeBookingCount!: number;

  @ApiProperty({ minimum: 0, example: 0 })
  changeHistoryCount!: number;
}

export class AdminRoomTimeResponseDto {
  @ApiProperty({ example: '1' })
  id!: string;

  @ApiProperty({ example: '1' })
  roomId!: string;

  @ApiProperty({ format: 'date', example: '2026-10-01' })
  availableFrom!: string;

  @ApiProperty({ format: 'date', example: '2026-12-01' })
  availableTo!: string;

  @ApiProperty({ enum: RoomTimeStatus })
  status!: RoomTimeStatus;

  @ApiProperty({ type: RoomTimeUsageResponseDto })
  usage!: RoomTimeUsageResponseDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}
