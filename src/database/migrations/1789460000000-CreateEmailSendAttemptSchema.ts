import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable evidence that a provider accepted a message, recorded independently of who
 * owns the claim.
 *
 * `email_deliveries` cannot carry this. A worker whose lease expired mid-send has no
 * right to write that row - that ownership rule is what `REVIEW-033` fixed - so the
 * one fact it does know, that the mail is out, had nowhere durable to go. The result
 * was a delivery that later reads `FAILED` although the guest already has the message,
 * and a redrive that duplicates it because no row ever reached `SENT`.
 *
 * An append-only table sidesteps the ownership problem entirely: inserting a new fact
 * conflicts with nobody, so a worker that has lost its claim can still record what it
 * did without touching state another worker now owns.
 *
 * It deliberately carries no foreign key to `outbox_events`, unlike `email_deliveries`.
 * An FK insert takes a shared lock on the parent row, and the parent row is exactly
 * what a recovering worker may already hold exclusively - so the write that must never
 * wait would be the one that waits. Orphans are not a real risk either: the id comes
 * from a row this worker just read under its own claim, and Phase 7 retention removes
 * both together.
 */
export class CreateEmailSendAttemptSchema1789460000000 implements MigrationInterface {
  name = 'CreateEmailSendAttemptSchema1789460000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE email_send_attempts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        outbox_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        template_key VARCHAR(100) NOT NULL,
        provider_message_id VARCHAR(255) NULL,
        claim_token VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        attempt SMALLINT UNSIGNED NOT NULL,
        accepted_at DATETIME(6) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_email_send_attempts_event (outbox_event_id, accepted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Same rule as the Phase 5 schema it extends: once an accepted send is recorded,
    // dropping the table destroys the only evidence that a guest was mailed, and the
    // redrive command silently loses its duplicate guard. Roll the application back or
    // fix forward instead.
    const evidence = (await queryRunner.query(
      'SELECT COUNT(*) AS accepted FROM email_send_attempts',
    )) as Array<{ accepted: string }>;
    if (Number(evidence[0].accepted) > 0) {
      throw new Error(
        'EMAIL_SEND_ATTEMPT_REVERT_BLOCKED: accepted-send evidence exists; roll the application back to a schema-compatible version or fix forward.',
      );
    }
    await queryRunner.query('DROP TABLE email_send_attempts');
  }
}
