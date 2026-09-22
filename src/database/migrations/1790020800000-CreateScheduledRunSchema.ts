import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Phase 7 run ledger.
 *
 * Additive, and read by nothing until `P7-T04` starts the scheduler, so applying it
 * ahead of the code that uses it is safe and is what the rollout asks for.
 *
 * `uq_scheduled_runs_window` is the reason this table exists in this shape. Replicas
 * racing the same window all try to insert it; MySQL lets one through and rejects the
 * rest with a duplicate key, so the election needs no lock, no Redis, and no
 * assumption that exactly one replica is deployed. The checks then keep the row
 * honest: a run is either claimed by somebody and unfinished, or finished and owned by
 * nobody. There is no state in which a row claims to be running and has no owner, and
 * none in which it has finished and still holds a lease.
 *
 * `down` drops the table, which is allowed while no run has happened. Afterwards it
 * discards the only record of what was deleted, so reverting is a decision about
 * losing evidence rather than a mechanical step.
 */
export class CreateScheduledRunSchema1790020800000 implements MigrationInterface {
  name = 'CreateScheduledRunSchema1790020800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE scheduled_runs (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        task_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        scheduled_for DATETIME(6) NOT NULL,
        status ENUM('CLAIMED', 'SUCCEEDED', 'FAILED') NOT NULL,
        locked_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lock_expires_at DATETIME(6) NULL,
        attempts TINYINT UNSIGNED NOT NULL DEFAULT 1,
        started_at DATETIME(6) NOT NULL,
        finished_at DATETIME(6) NULL,
        deleted_counts JSON NULL,
        last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        -- The election. One row per task per window, enforced by the database rather
        -- than by deploying one replica and hoping.
        UNIQUE KEY uq_scheduled_runs_window (task_name, scheduled_for),
        -- Recoverable-run scan: claimed rows whose lease has passed.
        KEY idx_scheduled_runs_recoverable (status, lock_expires_at),
        -- "What happened last night", for one task.
        KEY idx_scheduled_runs_history (task_name, scheduled_for),
        -- Either both lock columns are set or neither is. A lease without an owner
        -- cannot be reasoned about, and an owner without a lease never expires.
        CONSTRAINT chk_scheduled_runs_lock_shape CHECK (
          (locked_by IS NULL AND lock_expires_at IS NULL)
          OR (locked_by IS NOT NULL AND lock_expires_at IS NOT NULL)
        ),
        -- A claimed row may carry last_error_code: it belongs to the previous attempt,
        -- kept for the same reason a pending outbox event keeps one.
        CONSTRAINT chk_scheduled_runs_state_shape CHECK (
          (status = 'CLAIMED' AND locked_by IS NOT NULL AND finished_at IS NULL)
          OR
          (status = 'SUCCEEDED' AND locked_by IS NULL AND finished_at IS NOT NULL AND last_error_code IS NULL)
          OR
          (status = 'FAILED' AND locked_by IS NULL AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
        ),
        CONSTRAINT chk_scheduled_runs_finished_after_started CHECK (
          finished_at IS NULL OR finished_at >= started_at
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE scheduled_runs');
  }
}
