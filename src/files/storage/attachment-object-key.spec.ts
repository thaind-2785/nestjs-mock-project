import { createAttachmentsConfiguration } from '../../config/attachments.config';
import { validateEnvironment } from '../../config/environment.validation';
import { AttachmentPolicyRegistry } from '../attachment-policy';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from '../entities/attachment.enums';
import { buildAttachmentObjectKey } from './attachment-object-key';

const registry = new AttachmentPolicyRegistry(
  createAttachmentsConfiguration(validateEnvironment({})),
);
const albumPolicy = registry.resolve(
  AttachmentObjectType.Room,
  AttachmentAssociationType.Album,
);
const thumbnailPolicy = registry.resolve(
  AttachmentObjectType.Room,
  AttachmentAssociationType.Thumbnail,
);
const uuidPattern =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

describe('buildAttachmentObjectKey', () => {
  it('builds a target-scoped key from the verified MIME type', () => {
    const objectKey = buildAttachmentObjectKey({
      policy: albumPolicy,
      objectId: '42',
      mimeType: 'image/jpeg',
    });

    expect(objectKey).toMatch(
      new RegExp(`^attachments/room/42/album/${uuidPattern}\\.jpg$`),
    );
  });

  it('separates associations of the same target', () => {
    expect(
      buildAttachmentObjectKey({
        policy: thumbnailPolicy,
        objectId: '42',
        mimeType: 'image/png',
      }),
    ).toMatch(
      new RegExp(`^attachments/room/42/thumbnail/${uuidPattern}\\.png$`),
    );
  });

  it('never repeats a key for the same target and format', () => {
    const keys = new Set(
      Array.from({ length: 25 }, () =>
        buildAttachmentObjectKey({
          policy: albumPolicy,
          objectId: '42',
          mimeType: 'image/webp',
        }),
      ),
    );

    expect(keys.size).toBe(25);
  });

  it.each(['image/svg+xml', 'application/pdf', 'text/html', 'image/jpg'])(
    'rejects the unsupported MIME type %s',
    (mimeType) => {
      expect(() =>
        buildAttachmentObjectKey({
          policy: albumPolicy,
          objectId: '42',
          mimeType,
        }),
      ).toThrow('errors.attachmentMimeUnsupported');
    },
  );

  // The key is a storage path: an object ID that is not a surrogate key could
  // traverse prefixes or collide with another target's namespace.
  it.each(['0', '-1', '1.5', '01', '../7', 'room-42', '', ' 42'])(
    'rejects the invalid object ID %s',
    (objectId) => {
      expect(() =>
        buildAttachmentObjectKey({
          policy: albumPolicy,
          objectId,
          mimeType: 'image/jpeg',
        }),
      ).toThrow('Attachment target ID must be a decimal surrogate key');
    },
  );
});
