import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One provider acceptance, appended and never updated.
 *
 * This is deliberately not part of `EmailDelivery`'s state machine. The delivery row
 * is owned by whoever holds the outbox claim, and the worker that most needs to record
 * "the mail is out" is precisely the one that has just discovered it no longer holds
 * that claim. Appending a fact needs no ownership, so the evidence survives the very
 * race it exists to describe.
 */
@Entity({ name: 'email_send_attempts' })
@Index('idx_email_send_attempts_event', ['outboxEventId', 'acceptedAt'])
export class EmailSendAttempt {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'outbox_event_id', type: 'char', length: 36 })
  outboxEventId!: string;

  @Column({ name: 'template_key', type: 'varchar', length: 100 })
  templateKey!: string;

  /** Absent when the provider accepted without returning an identifier. */
  @Column({
    name: 'provider_message_id',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerMessageId!: string | null;

  /** Which claim was sending, so an operator can line this up with the worker log. */
  @Column({ name: 'claim_token', type: 'varchar', length: 100 })
  claimToken!: string;

  @Column({ type: 'smallint', unsigned: true })
  attempt!: number;

  @Column({ name: 'accepted_at', type: 'datetime', precision: 6 })
  acceptedAt!: Date;

  @Column({
    name: 'created_at',
    type: 'datetime',
    precision: 6,
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  createdAt!: Date;
}
