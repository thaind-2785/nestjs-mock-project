import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { StorageCleanupReason } from './attachment.enums';

@Entity({ name: 'storage_cleanup_tasks' })
@Index('uq_storage_cleanup_tasks_object_key', ['objectKey'], { unique: true })
@Index('idx_storage_cleanup_tasks_claim', ['availableAt', 'lockExpiresAt'])
export class StorageCleanupTask extends MutableEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'object_key', type: 'varchar', length: 512 })
  objectKey!: string;

  @Column({ type: 'enum', enum: StorageCleanupReason })
  reason!: StorageCleanupReason;

  @Column({ name: 'available_at', type: 'datetime', precision: 6 })
  availableAt!: Date;

  @Column({ name: 'locked_at', type: 'datetime', precision: 6, nullable: true })
  lockedAt!: Date | null;

  @Column({
    name: 'lock_expires_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lockExpiresAt!: Date | null;

  @Column({ name: 'locked_by', type: 'varchar', length: 100, nullable: true })
  lockedBy!: string | null;

  @Column({ type: 'smallint', unsigned: true, default: 0 })
  attempts!: number;
}
