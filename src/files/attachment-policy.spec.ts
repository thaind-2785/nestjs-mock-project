import { createAttachmentsConfiguration } from '../config/attachments.config';
import { validateEnvironment } from '../config/environment.validation';
import {
  AttachmentPolicyRegistry,
  createAttachmentPolicies,
} from './attachment-policy';
import { supportedImageMimeTypes } from './attachment.constants';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from './entities/attachment.enums';

const configuration = createAttachmentsConfiguration(
  validateEnvironment({
    ROOM_IMAGE_MAX_BYTES: '1048576',
    ROOM_IMAGE_MAX_ALBUM_COUNT: '7',
  }),
);
const registry = new AttachmentPolicyRegistry(configuration);

describe('attachment policy registry', () => {
  it('derives the room policies from configuration', () => {
    expect(createAttachmentPolicies(configuration)).toEqual([
      {
        objectType: AttachmentObjectType.Room,
        associationType: AttachmentAssociationType.Thumbnail,
        allowedMimeTypes: supportedImageMimeTypes,
        maxBytes: 1_048_576,
        maxCount: 1,
      },
      {
        objectType: AttachmentObjectType.Room,
        associationType: AttachmentAssociationType.Album,
        allowedMimeTypes: supportedImageMimeTypes,
        maxBytes: 1_048_576,
        maxCount: 7,
      },
    ]);
  });

  it('resolves a registered pair', () => {
    expect(
      registry.resolve(
        AttachmentObjectType.Room,
        AttachmentAssociationType.Album,
      ),
    ).toMatchObject({ maxCount: 7 });
  });

  // Deny-by-default: the pair matrix is not the cross product of both enums.
  it.each([
    [AttachmentObjectType.Room, AttachmentAssociationType.Avatar],
    [AttachmentObjectType.User, AttachmentAssociationType.Album],
    [AttachmentObjectType.User, AttachmentAssociationType.Thumbnail],
  ])('rejects the unsupported pair %s + %s', (objectType, associationType) => {
    expect(registry.supports(objectType, associationType)).toBe(false);
    expect(() => registry.resolve(objectType, associationType)).toThrow(
      'errors.attachmentPairInvalid',
    );
  });

  /**
   * `ADR-0003` allows USER+AVATAR, but Phase 3 ships no avatar endpoint or accepted
   * content limits, so the pair stays unregistered until both exist.
   */
  it('does not claim support for the declared avatar pair yet', () => {
    expect(
      registry.supports(
        AttachmentObjectType.User,
        AttachmentAssociationType.Avatar,
      ),
    ).toBe(false);
  });
});
