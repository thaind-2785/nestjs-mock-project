import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import {
  AttachmentAssociationType,
  AttachmentObjectType,
} from './attachment.enums';

@Entity({ name: 'attachments' })
@Index(
  'uq_attachments_target_position',
  ['objectType', 'objectId', 'associationType', 'position'],
  { unique: true },
)
@Index('uq_attachments_object_key', ['objectKey'], { unique: true })
@Index('idx_attachments_target', ['objectType', 'objectId'])
export class Attachment extends MutableEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'uploader_user_id', type: 'bigint', unsigned: true })
  uploaderUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'uploader_user_id' })
  uploader!: User;

  @Column({ name: 'object_type', type: 'varchar', length: 32 })
  objectType!: AttachmentObjectType;

  @Column({ name: 'object_id', type: 'bigint', unsigned: true })
  objectId!: string;

  @Column({ name: 'association_type', type: 'varchar', length: 32 })
  associationType!: AttachmentAssociationType;

  @Column({ type: 'smallint', unsigned: true })
  position!: number;

  @Column({ name: 'object_key', type: 'varchar', length: 512 })
  objectKey!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'bigint', unsigned: true })
  sizeBytes!: string;
}
