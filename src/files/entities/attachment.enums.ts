export enum AttachmentObjectType {
  Room = 'ROOM',
  User = 'USER',
}

export enum AttachmentAssociationType {
  Thumbnail = 'THUMBNAIL',
  Album = 'ALBUM',
  Avatar = 'AVATAR',
}

export enum StorageCleanupReason {
  UploadSafeguard = 'UPLOAD_SAFEGUARD',
  DetachedObject = 'DETACHED_OBJECT',
}
