import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  ValidateIf,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trim, trimAndUppercase } from './catalog-transforms';

export class CreateRoomTypeDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Deluxe' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2_000, nullable: true })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string | null;
}

// IsOptional skips null too; skip only undefined for non-nullable PATCH fields.
export class UpdateRoomTypeDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100, example: 'Deluxe' })
  @Transform(trim)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2_000, nullable: true })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  description?: string | null;
}

export class CreateAmenityDto {
  @ApiProperty({ minLength: 1, maxLength: 50, example: 'WIFI' })
  @Transform(trimAndUppercase)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Wi-Fi' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

export class UpdateAmenityDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 50, example: 'WIFI' })
  @Transform(trimAndUppercase)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100, example: 'Wi-Fi' })
  @Transform(trim)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
}
