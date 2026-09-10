/**
 * Raster formats the platform accepts for any image attachment. Keeping the map
 * from MIME type to extension here means the server never derives a storage path
 * segment from a client-supplied filename.
 */
export const attachmentImageExtensions: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const supportedImageMimeTypes = Object.keys(
  attachmentImageExtensions,
) as readonly string[];

/** Singleton associations (thumbnail, avatar) always occupy position 0. */
export const singletonAttachmentCount = 1;
