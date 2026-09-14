import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { EmailDeliveryLocale, EmailDeliveryStatus } from './notification.enums';

/**
 * One logical delivery per outbox event, recipient snapshot, and template.
 *
 * The unique tuple is what makes a retry a retry rather than a second message: the
 * worker locks or creates this row before it calls the provider, so a duplicate job,
 * a recovered lease, or a later attempt all resolve to the same record. The recipient
 * is stored because delivery evidence needs it; the rendered body and the provider's
 * error text are not stored, because neither is evidence and both carry content.
 */
@Entity({ name: 'email_deliveries' })
@Index(
  'uq_email_deliveries_logical',
  ['outboxEventId', 'recipient', 'templateKey'],
  { unique: true },
)
@Index('idx_email_deliveries_status_created', ['status', 'createdAt', 'id'])
@Check(
  'chk_email_deliveries_state',
  "(`status` = 'PENDING' AND `sent_at` IS NULL AND `failed_at` IS NULL AND `provider_message_id` IS NULL) OR (`status` = 'SENT' AND `sent_at` IS NOT NULL AND `failed_at` IS NULL AND `last_error_code` IS NULL) OR (`status` = 'FAILED' AND `sent_at` IS NULL AND `failed_at` IS NOT NULL AND `last_error_code` IS NOT NULL)",
)
export class EmailDelivery extends MutableEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'outbox_event_id', type: 'char', length: 36 })
  outboxEventId!: string;

  @Column({ type: 'varchar', length: 255 })
  recipient!: string;

  @Column({ name: 'template_key', type: 'varchar', length: 100 })
  templateKey!: string;

  @Column({ type: 'enum', enum: EmailDeliveryLocale })
  locale!: EmailDeliveryLocale;

  @Column({
    type: 'enum',
    enum: EmailDeliveryStatus,
    default: EmailDeliveryStatus.Pending,
  })
  status!: EmailDeliveryStatus;

  // Cumulative across retries and preserved by a redrive, so the history of one
  // logical delivery is not reset by an operator correcting its cause.
  @Column({ type: 'smallint', unsigned: true, default: 0 })
  attempts!: number;

  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId!: string | null;

  // A stable code from the delivery classifier, never raw provider text.
  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;

  @Column({ name: 'sent_at', type: 'datetime', precision: 6, nullable: true })
  sentAt!: Date | null;

  @Column({ name: 'failed_at', type: 'datetime', precision: 6, nullable: true })
  failedAt!: Date | null;
}
