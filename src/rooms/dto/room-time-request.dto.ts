import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import { RoomTimeStatus } from '../entities/room.enums';

const hotelDatePattern = /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/;
const hotelDateValidationOptions = {
  strict: true,
  strictSeparator: true,
} as const;

export class CreateRoomTimeDto {
  @ApiProperty({ format: 'date', example: '2026-10-01' })
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  availableFrom!: string;

  @ApiProperty({ format: 'date', example: '2026-12-01' })
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  availableTo!: string;

  @ApiPropertyOptional({
    enum: RoomTimeStatus,
    default: RoomTimeStatus.Active,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(RoomTimeStatus)
  status: RoomTimeStatus = RoomTimeStatus.Active;
}

export class UpdateRoomTimeDto {
  @ApiPropertyOptional({ format: 'date', example: '2026-10-01' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  availableFrom?: string;

  @ApiPropertyOptional({ format: 'date', example: '2026-12-01' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(hotelDatePattern)
  @IsDateString(hotelDateValidationOptions)
  availableTo?: string;

  @ApiPropertyOptional({ enum: RoomTimeStatus })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(RoomTimeStatus)
  status?: RoomTimeStatus;
}
