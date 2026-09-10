import { ApiProperty } from '@nestjs/swagger';
import { AttachmentAssociationType } from '../../files/entities/attachment.enums';

/**
 * Admin image payload. It carries a short-lived presigned read, never the object
 * key or bucket, so metadata cannot be turned into a durable storage reference.
 */
export class RoomImageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: AttachmentAssociationType })
  associationType!: string;

  @ApiProperty({ minimum: 0, example: 0 })
  position!: number;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType!: string;

  @ApiProperty({ example: 204_800 })
  sizeBytes!: number;

  @ApiProperty({ description: 'Short-lived presigned GET URL.' })
  url!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}
