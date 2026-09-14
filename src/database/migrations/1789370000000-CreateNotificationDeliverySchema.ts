import { MigrationInterface, QueryRunner } from 'typeorm';

const phaseFourLeaseState =
  "(status = 'PENDING' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NULL)" +
  " OR (status = 'PROCESSING' AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL AND locked_by IS NOT NULL AND processed_at IS NULL)" +
  " OR (status = 'PROCESSED' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NOT NULL)";

export class CreateNotificationDeliverySchema1789370000000 implements MigrationInterface {
  name = 'CreateNotificationDeliverySchema1789370000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Additive on the Phase 4 outbox: existing PENDING, PROCESSING, and PROCESSED
    // rows stay valid, and the widened check simply denies the new state the shapes
    // that would contradict it.
    await queryRunner.query(
      'ALTER TABLE outbox_events DROP CHECK chk_outbox_events_lease_state',
    );
    await queryRunner.query(`
      ALTER TABLE outbox_events
        MODIFY COLUMN status ENUM('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'PENDING',
        ADD COLUMN last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER attempts,
        ADD COLUMN failed_at DATETIME(6) NULL AFTER last_error_code
    `);
    await queryRunner.query(`
      ALTER TABLE outbox_events
        ADD CONSTRAINT chk_outbox_events_lease_state CHECK (
          (status = 'PENDING' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NULL AND failed_at IS NULL)
          OR
          (status = 'PROCESSING' AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL AND locked_by IS NOT NULL AND processed_at IS NULL AND failed_at IS NULL)
          OR
          (status = 'PROCESSED' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NOT NULL AND failed_at IS NULL AND last_error_code IS NULL)
          OR
          (status = 'FAILED' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NULL AND failed_at IS NOT NULL AND last_error_code IS NOT NULL)
        )
    `);
    await queryRunner.query(`
      CREATE TABLE email_deliveries (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        outbox_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        recipient VARCHAR(255) NOT NULL,
        template_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        locale ENUM('en', 'vi') NOT NULL,
        status ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
        attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        provider_message_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
        last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        sent_at DATETIME(6) NULL,
        failed_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_email_deliveries_logical (outbox_event_id, recipient, template_key),
        KEY idx_email_deliveries_status_created (status, created_at, id),
        CONSTRAINT fk_email_deliveries_outbox_event FOREIGN KEY (outbox_event_id) REFERENCES outbox_events(id) ON DELETE RESTRICT,
        CONSTRAINT chk_email_deliveries_state CHECK (
          (status = 'PENDING' AND sent_at IS NULL AND failed_at IS NULL AND provider_message_id IS NULL)
          OR
          (status = 'SENT' AND sent_at IS NOT NULL AND failed_at IS NULL AND last_error_code IS NULL)
          OR
          (status = 'FAILED' AND sent_at IS NULL AND failed_at IS NOT NULL AND last_error_code IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Mechanically reversible only before Phase 5 records its first result. Once a
    // delivery or a terminal failure exists, dropping this schema would destroy the
    // only record of what was or was not sent, so the revert refuses and the
    // deployment rolls the application back or fixes forward instead.
    const evidence = (await queryRunner.query(`
      SELECT
        (SELECT COUNT(*) FROM email_deliveries) AS deliveries,
        (SELECT COUNT(*) FROM outbox_events WHERE status = 'FAILED') AS failed
    `)) as Array<{ deliveries: string; failed: string }>;
    if (Number(evidence[0].deliveries) > 0 || Number(evidence[0].failed) > 0) {
      throw new Error(
        'NOTIFICATION_DELIVERY_REVERT_BLOCKED: delivery evidence exists; roll the application back to a schema-compatible version or fix forward.',
      );
    }

    await queryRunner.query('DROP TABLE email_deliveries');
    await queryRunner.query(
      'ALTER TABLE outbox_events DROP CHECK chk_outbox_events_lease_state',
    );
    await queryRunner.query(`
      ALTER TABLE outbox_events
        DROP COLUMN failed_at,
        DROP COLUMN last_error_code,
        MODIFY COLUMN status ENUM('PENDING', 'PROCESSING', 'PROCESSED') NOT NULL DEFAULT 'PENDING'
    `);
    await queryRunner.query(
      `ALTER TABLE outbox_events ADD CONSTRAINT chk_outbox_events_lease_state CHECK (${phaseFourLeaseState})`,
    );
  }
}
