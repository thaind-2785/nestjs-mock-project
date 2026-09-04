import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

const decimalIdPattern = /^[1-9][0-9]{0,19}$/;

export class RoomIdParamDto {
  @ApiProperty({ example: '1', pattern: decimalIdPattern.source })
  @IsString()
  @Matches(decimalIdPattern)
  roomId!: string;
}

export class RoomTypeIdParamDto {
  @ApiProperty({ example: '1', pattern: decimalIdPattern.source })
  @IsString()
  @Matches(decimalIdPattern)
  roomTypeId!: string;
}

export class AmenityIdParamDto {
  @ApiProperty({ example: '1', pattern: decimalIdPattern.source })
  @IsString()
  @Matches(decimalIdPattern)
  amenityId!: string;
}

export { decimalIdPattern };
