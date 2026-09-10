import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { User } from '../../users/entities/user.entity';
import { IdempotencyKeyStatus } from './booking.enums';

@Entity({ name: 'idempotency_keys' })
@Index(
  'uq_idempotency_keys_actor_operation_key',
  ['actorUserId', 'operation', 'idempotencyKey'],
  { unique: true },
)
@Index('idx_idempotency_keys_expires', ['expiresAt'])
@Check(
  'chk_idempotency_keys_completed_response',
  "(`status` = 'PENDING' AND `response_status` IS NULL AND `response_body` IS NULL) OR (`status` = 'COMPLETED' AND `response_status` IS NOT NULL AND `response_body` IS NOT NULL)",
)
export class IdempotencyKey extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'actor_user_id', type: 'bigint', unsigned: true })
  actorUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser!: User;

  @Column({ type: 'varchar', length: 64 })
  operation!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 })
  idempotencyKey!: string;

  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint!: string;

  @Column({
    type: 'enum',
    enum: IdempotencyKeyStatus,
    default: IdempotencyKeyStatus.Pending,
  })
  status!: IdempotencyKeyStatus;

  @Column({
    name: 'response_status',
    type: 'smallint',
    unsigned: true,
    nullable: true,
  })
  responseStatus!: number | null;

  @Column({ name: 'response_body', type: 'json', nullable: true })
  responseBody!: Record<string, unknown> | null;

  @Column({ name: 'expires_at', type: 'datetime', precision: 6 })
  expiresAt!: Date;
}
