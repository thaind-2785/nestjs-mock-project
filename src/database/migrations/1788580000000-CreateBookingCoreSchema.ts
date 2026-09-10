import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookingCoreSchema1788580000000 implements MigrationInterface {
  name = 'CreateBookingCoreSchema1788580000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE bookings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        public_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        room_time_id BIGINT UNSIGNED NOT NULL,
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        status ENUM('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN', 'COMPLETED') NOT NULL DEFAULT 'PENDING',
        price_amount BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        rejection_reason TEXT NULL,
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_bookings_public_id (public_id),
        KEY idx_bookings_user_created (user_id, created_at, id),
        KEY idx_bookings_status_check_in_out (status, check_in, check_out),
        KEY idx_bookings_room_time_status_check_in_out (room_time_id, status, check_in, check_out),
        CONSTRAINT chk_bookings_range CHECK (check_in < check_out),
        CONSTRAINT chk_bookings_price_safe_integer CHECK (price_amount <= 9007199254740991),
        CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_bookings_room_time FOREIGN KEY (room_time_id) REFERENCES room_times(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE booking_status_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        booking_id BIGINT UNSIGNED NOT NULL,
        from_status ENUM('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN', 'COMPLETED') NULL,
        to_status ENUM('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN', 'COMPLETED') NOT NULL,
        actor_type ENUM('USER', 'ADMIN', 'SYSTEM') NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        reason TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_booking_status_history_booking_created (booking_id, created_at),
        KEY idx_booking_status_history_actor (actor_user_id),
        CONSTRAINT fk_booking_status_history_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_status_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE booking_change_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        booking_id BIGINT UNSIGNED NOT NULL,
        actor_user_id BIGINT UNSIGNED NOT NULL,
        from_room_time_id BIGINT UNSIGNED NOT NULL,
        to_room_time_id BIGINT UNSIGNED NOT NULL,
        from_check_in DATE NOT NULL,
        from_check_out DATE NOT NULL,
        to_check_in DATE NOT NULL,
        to_check_out DATE NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_booking_change_history_booking_created (booking_id, created_at),
        KEY idx_booking_change_history_actor (actor_user_id),
        CONSTRAINT fk_booking_change_history_booking FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_change_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_change_history_from_room_time FOREIGN KEY (from_room_time_id) REFERENCES room_times(id) ON DELETE RESTRICT,
        CONSTRAINT fk_booking_change_history_to_room_time FOREIGN KEY (to_room_time_id) REFERENCES room_times(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_user_id BIGINT UNSIGNED NOT NULL,
        operation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        request_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status ENUM('PENDING', 'COMPLETED') NOT NULL DEFAULT 'PENDING',
        response_status SMALLINT UNSIGNED NULL,
        response_body JSON NULL,
        expires_at DATETIME(6) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_idempotency_keys_actor_operation_key (actor_user_id, operation, idempotency_key),
        KEY idx_idempotency_keys_expires (expires_at),
        CONSTRAINT chk_idempotency_keys_completed_response CHECK (
          (status = 'PENDING' AND response_status IS NULL AND response_body IS NULL)
          OR
          (status = 'COMPLETED' AND response_status IS NOT NULL AND response_body IS NOT NULL)
        ),
        CONSTRAINT fk_idempotency_keys_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        event_type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payload JSON NOT NULL,
        available_at DATETIME(6) NOT NULL,
        status ENUM('PENDING', 'PROCESSING', 'PROCESSED') NOT NULL DEFAULT 'PENDING',
        idempotency_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        locked_at DATETIME(6) NULL,
        lock_expires_at DATETIME(6) NULL,
        locked_by VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
        processed_at DATETIME(6) NULL,
        attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_outbox_events_idempotency_key (idempotency_key),
        KEY idx_outbox_events_claim (status, available_at, lock_expires_at),
        CONSTRAINT chk_outbox_events_lease_state CHECK (
          (status = 'PENDING' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NULL)
          OR
          (status = 'PROCESSING' AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL AND locked_by IS NOT NULL AND processed_at IS NULL)
          OR
          (status = 'PROCESSED' AND locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL AND processed_at IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_events');
    await queryRunner.query('DROP TABLE idempotency_keys');
    await queryRunner.query('DROP TABLE booking_change_history');
    await queryRunner.query('DROP TABLE booking_status_history');
    await queryRunner.query('DROP TABLE bookings');
  }
}
