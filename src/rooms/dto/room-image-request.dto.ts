import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsEnum, IsUUID } from 'class-validator';
import { AttachmentAssociationType } from '../../files/entities/attachment.enums';
import { maxRoomImageOrderSize } from '../room-images.constants';

/** Room images accept only the two room-scoped associations, never AVATAR. */
export const roomImageAssociationTypes = [
  AttachmentAssociationType.Thumbnail,
  AttachmentAssociationType.Album,
] as const;

export class UploadRoomImageDto {
  @ApiProperty({ enum: roomImageAssociationTypes })
  @IsEnum(AttachmentAssociationType)
  @IsEnum(roomImageAssociationTypes, {
    message: 'associationType must be THUMBNAIL or ALBUM',
  })
  associationType!: AttachmentAssociationType;
}

export class ReorderRoomImagesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Every current album attachment ID exactly once, in the intended order.',
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(maxRoomImageOrderSize)
  @IsUUID('4', { each: true })
  attachmentIds!: string[];
}
