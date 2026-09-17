import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Phase 6 export schema, and the outbox index two consumers now need.
 *
 * `export_jobs` is additive: nothing in Phase 4 or 5 reads it, so applying this ahead
 * of the code that uses it is safe and is what the rollout asks for.
 *
 * The checks are the point of the table. It is written by two processes on different
 * schedules - the API creates the row, the worker finishes it - so the invariant
 * enforced here is not that the code is careful but that a completed job has a whole
 * result and a failed job has none of one. A half-written completion is precisely the
 * shape that would hand an administrator a download URL for an object that was never
 * uploaded.
 *
 * Both foreign keys are `RESTRICT`. The outbox event is the job's durable trigger and
 * the requester is its permanent owner; deleting either while a job references it
 * would leave a result whose provenance cannot be established, which is worse than a
 * refused delete an operator has to think about.
 */
export class CreateRoomExportSchema1789640000000 implements MigrationInterface {
  name = 'CreateRoomExportSchema1789640000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE export_jobs (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        requested_by BIGINT UNSIGNED NOT NULL,
        outbox_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
        filters JSON NOT NULL,
        object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
        row_count BIGINT UNSIGNED NULL,
        file_size_bytes BIGINT UNSIGNED NULL,
        content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        started_at DATETIME(6) NULL,
        completed_at DATETIME(6) NULL,
        expires_at DATETIME(6) NULL,
        failed_at DATETIME(6) NULL,
        last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_export_jobs_outbox_event (outbox_event_id),
        KEY idx_export_jobs_owner (requested_by, created_at, id),
        KEY idx_export_jobs_operations (status, updated_at, id),
        CONSTRAINT chk_export_jobs_state_shape CHECK (
          (status IN ('QUEUED', 'PROCESSING') AND object_key IS NULL AND row_count IS NULL AND file_size_bytes IS NULL AND content_sha256 IS NULL AND completed_at IS NULL AND expires_at IS NULL AND failed_at IS NULL)
          OR
          (status = 'COMPLETED' AND object_key IS NOT NULL AND row_count IS NOT NULL AND file_size_bytes IS NOT NULL AND content_sha256 IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL AND expires_at IS NOT NULL AND failed_at IS NULL AND last_error_code IS NULL)
          OR
          (status = 'FAILED' AND object_key IS NULL AND row_count IS NULL AND file_size_bytes IS NULL AND content_sha256 IS NULL AND completed_at IS NULL AND expires_at IS NULL AND failed_at IS NOT NULL AND last_error_code IS NOT NULL)
        ),
        CONSTRAINT chk_export_jobs_started_before_completed CHECK (
          started_at IS NULL OR completed_at IS NULL OR completed_at >= started_at
        ),
        -- BIGINT UNSIGNED already excludes negatives; the ceiling is the one that
        -- matters. A count past 2^53 - 1 reaches the API as a rounded JavaScript
        -- number, so a value MySQL would accept becomes a different value by the time
        -- an administrator reads it.
        CONSTRAINT chk_export_jobs_result_bounds CHECK (
          (row_count IS NULL OR row_count <= 9007199254740991)
          AND (file_size_bytes IS NULL OR file_size_bytes <= 9007199254740991)
        ),
        CONSTRAINT fk_export_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_export_jobs_outbox_event FOREIGN KEY (outbox_event_id) REFERENCES outbox_events(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    // Leads on `event_type` so a single-family dispatcher - which the export consumer
    // is - gets an ordered range scan and no sort. The notification claim keeps four
    // types and is expected to stay on `idx_outbox_events_claim`, whose leading
    // `status` still yields `available_at` order directly; a multi-value `IN` on the
    // leading column here could not. Both indexes therefore remain until `EXPLAIN`
    // against a mixed and a skewed backlog says otherwise, which is also why this
    // migration adds one rather than replacing one.
    await queryRunner.query(
      'CREATE INDEX idx_outbox_events_claim_by_type ON outbox_events (event_type, status, available_at, lock_expires_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Allowed only before the first export job exists. After activation this `down`
    // would drop the job rows that prove which object belongs to whom, and the
    // documented rollback is a schema-compatible application or a forward fix instead.
    await queryRunner.query(
      'DROP INDEX idx_outbox_events_claim_by_type ON outbox_events',
    );
    await queryRunner.query('DROP TABLE export_jobs');
  }
}
