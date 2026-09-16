import type { AttachmentAssociationType } from '../files/entities/attachment.enums';
import type { RoomImageResponseDto } from './dto/room-image-response.dto';

export interface RoomImageUpload {
  associationType: AttachmentAssociationType;
  uploaderUserId: string;
  declaredMimeType: string;
  body: Buffer;
}

export interface RoomImageSet {
  thumbnail: RoomImageResponseDto | null;
  album: RoomImageResponseDto[];
}
