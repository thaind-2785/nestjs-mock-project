import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsISO4217CurrencyCode,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RoomStatus } from '../entities/room.enums';
import { decimalIdPattern } from './room-id-param.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimAndUppercase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreateRoomDto {
  @ApiProperty({ minLength: 1, maxLength: 50, example: 'A-201' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  roomNumber!: string;

  @ApiProperty({ example: '1', pattern: decimalIdPattern.source })
  @IsString()
  @Matches(decimalIdPattern)
  roomTypeId!: string;

  @ApiProperty({ minimum: 1, maximum: 20, example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  bedCount!: number;

  @ApiPropertyOptional({ maxLength: 50, nullable: true, example: 'CITY' })
  @Transform(trimAndUppercase)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  viewCode?: string | null;

  @ApiProperty({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    example: 1500000,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  basePriceAmount!: number;

  @ApiProperty({ example: 'VND' })
  @Transform(trimAndUppercase)
  @IsString()
  @IsISO4217CurrencyCode()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @ApiPropertyOptional({ enum: RoomStatus, default: RoomStatus.Active })
  @IsOptional()
  @IsEnum(RoomStatus)
  status: RoomStatus = RoomStatus.Active;

  @ApiPropertyOptional({ type: [String], example: ['1', '2'], default: [] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(decimalIdPattern, { each: true })
  amenityIds: string[] = [];
}

export class UpdateRoomDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 50, example: 'A-201' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  roomNumber?: string;

  @ApiPropertyOptional({ example: '1', pattern: decimalIdPattern.source })
  @IsOptional()
  @IsString()
  @Matches(decimalIdPattern)
  roomTypeId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  bedCount?: number;

  @ApiPropertyOptional({ maxLength: 50, nullable: true, example: 'CITY' })
  @Transform(trimAndUppercase)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  viewCode?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  basePriceAmount?: number;

  @ApiPropertyOptional({ example: 'VND' })
  @Transform(trimAndUppercase)
  @IsOptional()
  @IsString()
  @IsISO4217CurrencyCode()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ enum: RoomStatus })
  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @ApiPropertyOptional({ type: [String], example: ['1', '2'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(decimalIdPattern, { each: true })
  amenityIds?: string[];
}
