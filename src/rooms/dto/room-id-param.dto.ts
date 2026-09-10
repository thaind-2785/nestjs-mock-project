import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';
import { decimalIdPattern } from '../../common/constants/identifier.constants';

export class RoomIdParamDto {
  @ApiProperty({ example: '1', pattern: decimalIdPattern.source })
  @IsString()
  @Matches(decimalIdPattern)
  roomId!: string;
}

export class RoomTimeIdParamDto extends RoomIdParamDto {
  @ApiProperty({ example: '1', pattern: decimalIdPattern.source })
  @IsString()
  @Matches(decimalIdPattern)
  roomTimeId!: string;
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

export class RoomImageIdParamDto extends RoomIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  attachmentId!: string;
}
