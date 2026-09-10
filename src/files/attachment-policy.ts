import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  attachmentsConfig,
  AttachmentsConfiguration,
} from '../config/attachments.config';
import {
  singletonAttachmentCount,
  supportedImageMimeTypes,
} from './attachment.constants';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from './entities/attachment.enums';
import { filesErrors } from './files.errors';

export interface AttachmentPolicy {
  objectType: AttachmentObjectType;
  associationType: AttachmentAssociationType;
  allowedMimeTypes: readonly string[];
  maxBytes: number;
  /** Maximum live attachments per target for this association; 1 is a singleton. */
  maxCount: number;
}

function policyKey(
  objectType: AttachmentObjectType,
  associationType: AttachmentAssociationType,
): string {
  return `${objectType}:${associationType}`;
}

/**
 * `ADR-0003` allows `ROOM+THUMBNAIL`, `ROOM+ALBUM`, and `USER+AVATAR`. Only the
 * pairs with an owning endpoint and accepted limits are registered: an allowlist
 * entry no surface can reach would claim support the platform does not have.
 * Adding the avatar pair is one entry plus its own content limits.
 */
export function createAttachmentPolicies(
  configuration: AttachmentsConfiguration,
): AttachmentPolicy[] {
  return [
    {
      objectType: AttachmentObjectType.Room,
      associationType: AttachmentAssociationType.Thumbnail,
      allowedMimeTypes: supportedImageMimeTypes,
      maxBytes: configuration.roomImage.maxBytes,
      maxCount: singletonAttachmentCount,
    },
    {
      objectType: AttachmentObjectType.Room,
      associationType: AttachmentAssociationType.Album,
      allowedMimeTypes: supportedImageMimeTypes,
      maxBytes: configuration.roomImage.maxBytes,
      maxCount: configuration.roomImage.maxAlbumCount,
    },
  ];
}

@Injectable()
export class AttachmentPolicyRegistry {
  private readonly policies: ReadonlyMap<string, AttachmentPolicy>;

  public constructor(
    @Inject(attachmentsConfig.KEY)
    configuration: ConfigType<typeof attachmentsConfig>,
  ) {
    this.policies = new Map(
      createAttachmentPolicies(configuration).map((policy) => [
        policyKey(policy.objectType, policy.associationType),
        policy,
      ]),
    );
  }

  /** Deny-by-default: an unregistered pair is rejected, never defaulted. */
  public resolve(
    objectType: AttachmentObjectType,
    associationType: AttachmentAssociationType,
  ): AttachmentPolicy {
    const policy = this.policies.get(policyKey(objectType, associationType));
    if (!policy) throw filesErrors.attachmentPairInvalid();
    return policy;
  }

  public supports(
    objectType: AttachmentObjectType,
    associationType: AttachmentAssociationType,
  ): boolean {
    return this.policies.has(policyKey(objectType, associationType));
  }
}
