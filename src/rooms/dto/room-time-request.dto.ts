import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import { RoomTimeStatus } from '../entities/room.enums';
import { hotelDatePattern, hotelDateValidationOptions } from './hotel-date';

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
