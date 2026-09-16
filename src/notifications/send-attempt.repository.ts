import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { RecordAcceptedSendInput } from './send-attempt.types';

/**
 * Appends the fact that a provider accepted a message, and answers whether one exists.
 *
 * There is no update and no delete. That is the whole point: the writer is often a
 * worker that has just lost its claim, and an append conflicts with no owner. It also
 * means this table can never contradict `email_deliveries` - it makes a narrower
 * statement ("a provider took this") than the delivery's ("this is the outcome").
 */
@Injectable()
export class SendAttemptRepository {
  async recordAccepted(
    manager: EntityManager,
    input: RecordAcceptedSendInput,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO email_send_attempts
         (outbox_event_id, template_key, provider_message_id, claim_token, attempt, accepted_at)
       VALUES (?, ?, ?, ?, ?, NOW(6))`,
      [
        input.outboxEventId,
        input.templateKey,
        input.providerMessageId,
        input.claimToken,
        input.attempt,
      ],
    );
  }

  async countAccepted(
    manager: EntityManager,
    outboxEventId: string,
  ): Promise<number> {
    const rows: Array<{ accepted: string | number }> = await manager.query(
      'SELECT COUNT(*) AS accepted FROM email_send_attempts WHERE outbox_event_id = ?',
      [outboxEventId],
    );
    return Number(rows[0]?.accepted ?? 0);
  }
}
