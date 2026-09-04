import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UserIdParamDto {
  @ApiProperty({ example: '1', pattern: '^[1-9][0-9]{0,19}$' })
  @IsString()
  @Matches(/^[1-9][0-9]{0,19}$/)
  userId!: string;
}
