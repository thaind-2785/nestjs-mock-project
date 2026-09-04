import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { UserStatus } from '../entities/user.enums';

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus, example: UserStatus.Inactive })
  @IsEnum(UserStatus)
  status!: UserStatus;

  @ApiProperty({
    minLength: 1,
    maxLength: 1_000,
    example: 'Policy violation',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(1_000)
  reason!: string;
}
