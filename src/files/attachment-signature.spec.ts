import { createAttachmentsConfiguration } from '../config/attachments.config';
import { validateEnvironment } from '../config/environment.validation';
import { AttachmentPolicyRegistry } from './attachment-policy';
import {
  attachmentSignatureHeadBytes,
  detectAttachmentMimeType,
  verifyAttachmentContent,
} from './attachment-signature';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from './entities/attachment.enums';

const policy = new AttachmentPolicyRegistry(
  createAttachmentsConfiguration(
    validateEnvironment({ ROOM_IMAGE_MAX_BYTES: '2048' }),
  ),
).resolve(AttachmentObjectType.Room, AttachmentAssociationType.Album);

const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(64, 0x11),
]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x22),
]);
const webp = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(64, 0x33),
]);
// A RIFF container that is not WebP: WAV and AVI share the outer form.
const wav = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x40, 0x00, 0x00, 0x00]),
  Buffer.from('WAVE', 'latin1'),
  Buffer.alloc(64, 0x44),
]);
const gif = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.alloc(64, 0x55),
]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const pdf = Buffer.from('%PDF-1.7\n%binary');

describe('detectAttachmentMimeType', () => {
  it.each([
    ['image/jpeg', jpeg],
    ['image/png', png],
    ['image/webp', webp],
  ])('identifies %s from its own bytes', (mimeType, body) => {
    expect(detectAttachmentMimeType(body)).toBe(mimeType);
  });

  it.each([
    ['a RIFF container that is not WebP', wav],
    ['GIF', gif],
    ['SVG markup', svg],
    ['PDF', pdf],
    ['plain text', Buffer.from('just text pretending to be a photo')],
    ['empty content', Buffer.alloc(0)],
  ])('does not identify %s', (_label, body) => {
    expect(detectAttachmentMimeType(body)).toBeUndefined();
  });

  // A truncated upload must not be classified from bytes that are not present.
  it.each([1, 2, 3, 7, 11])(
    'does not identify a %s-byte prefix of a WebP header',
    (length) => {
      expect(detectAttachmentMimeType(webp.subarray(0, length))).not.toBe(
        'image/webp',
      );
    },
  );

  it('decides every accepted format inside the bounded head', () => {
    expect(attachmentSignatureHeadBytes).toBe(12);
    for (const body of [jpeg, png, webp]) {
      expect(detectAttachmentMimeType(body)).toBe(
        detectAttachmentMimeType(
          body.subarray(0, attachmentSignatureHeadBytes),
        ),
      );
    }
  });
});

describe('verifyAttachmentContent', () => {
  it('returns the verified type when bytes and header agree', () => {
    expect(
      verifyAttachmentContent({
        policy,
        declaredMimeType: 'image/png',
        body: png,
      }),
    ).toBe('image/png');
  });

  it.each([
    ['image/gif', gif],
    ['image/svg+xml', svg],
    ['application/pdf', pdf],
  ])('rejects the unsupported declared type %s', (declaredMimeType, body) => {
    expect(() =>
      verifyAttachmentContent({ policy, declaredMimeType, body }),
    ).toThrow('errors.attachmentMimeUnsupported');
  });

  // The header is a claim, not evidence: an accepted header over other bytes is
  // exactly how an upload filter is bypassed.
  it.each([
    ['a PDF declared as PNG', 'image/png', pdf],
    ['SVG markup declared as PNG', 'image/png', svg],
    ['a WAV container declared as WebP', 'image/webp', wav],
    ['JPEG bytes declared as PNG', 'image/png', jpeg],
  ])('rejects %s', (_label, declaredMimeType, body) => {
    expect(() =>
      verifyAttachmentContent({ policy, declaredMimeType, body }),
    ).toThrow('errors.attachmentContentInvalid');
  });

  it('rejects an empty upload', () => {
    expect(() =>
      verifyAttachmentContent({
        policy,
        declaredMimeType: 'image/png',
        body: Buffer.alloc(0),
      }),
    ).toThrow('errors.attachmentContentInvalid');
  });

  it('rejects content above the policy size limit', () => {
    const oversized = Buffer.concat([png, Buffer.alloc(policy.maxBytes)]);

    expect(() =>
      verifyAttachmentContent({
        policy,
        declaredMimeType: 'image/png',
        body: oversized,
      }),
    ).toThrow('errors.attachmentSizeExceeded');
  });

  it('accepts content at exactly the policy size limit', () => {
    const exact = Buffer.concat([
      png,
      Buffer.alloc(policy.maxBytes - png.byteLength),
    ]);

    expect(
      verifyAttachmentContent({
        policy,
        declaredMimeType: 'image/png',
        body: exact,
      }),
    ).toBe('image/png');
  });

  /**
   * Documented boundary: signature verification is not a content scanner. Trailing
   * data after a valid header is stored, which is why the object is served only
   * through presigned reads with its verified content type.
   */
  it('accepts a valid image header followed by unrelated trailing data', () => {
    expect(
      verifyAttachmentContent({
        policy,
        declaredMimeType: 'image/png',
        body: Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]),
      }),
    ).toBe('image/png');
  });
});
