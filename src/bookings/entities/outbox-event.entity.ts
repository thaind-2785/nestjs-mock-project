import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { OutboxEventStatus } from './booking.enums';

@Entity({ name: 'outbox_events' })
@Index('uq_outbox_events_idempotency_key', ['idempotencyKey'], { unique: true })
@Index('idx_outbox_events_claim', ['status', 'availableAt', 'lockExpiresAt'])
@Check(
  'chk_outbox_events_lease_state',
  "(`status` = 'PENDING' AND `locked_at` IS NULL AND `lock_expires_at` IS NULL AND `locked_by` IS NULL AND `processed_at` IS NULL) OR (`status` = 'PROCESSING' AND `locked_at` IS NOT NULL AND `lock_expires_at` IS NOT NULL AND `locked_by` IS NOT NULL AND `processed_at` IS NULL) OR (`status` = 'PROCESSED' AND `locked_at` IS NULL AND `lock_expires_at` IS NULL AND `locked_by` IS NULL AND `processed_at` IS NOT NULL)",
)
export class OutboxEvent extends MutableEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType!: string;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({ name: 'available_at', type: 'datetime', precision: 6 })
  availableAt!: Date;

  @Column({
    type: 'enum',
    enum: OutboxEventStatus,
    default: OutboxEventStatus.Pending,
  })
  status!: OutboxEventStatus;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

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

  @Column({
    name: 'processed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  processedAt!: Date | null;

  @Column({ type: 'smallint', unsigned: true, default: 0 })
  attempts!: number;
}
