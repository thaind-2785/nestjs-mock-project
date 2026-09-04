import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimAndUppercase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

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

export class UpdateRoomTypeDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 100, example: 'Deluxe' })
  @Transform(trim)
  @IsOptional()
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
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100, example: 'Wi-Fi' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
}
