import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRoomCatalogSchema1788490000000 implements MigrationInterface {
  name = 'CreateRoomCatalogSchema1788490000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE room_types (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        description TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_room_types_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE amenities (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        code VARCHAR(50) NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_amenities_code (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE rooms (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        room_type_id BIGINT UNSIGNED NOT NULL,
        room_number VARCHAR(50) NOT NULL,
        bed_count SMALLINT UNSIGNED NOT NULL,
        view_code VARCHAR(50) NULL,
        base_price_amount BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status ENUM('ACTIVE', 'INACTIVE', 'MAINTENANCE') NOT NULL DEFAULT 'ACTIVE',
        version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_rooms_room_number (room_number),
        KEY idx_rooms_status_type (status, room_type_id),
        KEY idx_rooms_bed_count (bed_count),
        KEY idx_rooms_view_code (view_code),
        CONSTRAINT chk_rooms_bed_count CHECK (bed_count BETWEEN 1 AND 20),
        CONSTRAINT chk_rooms_price_safe_integer CHECK (base_price_amount <= 9007199254740991),
        CONSTRAINT fk_rooms_room_type FOREIGN KEY (room_type_id) REFERENCES room_types(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE room_amenities (
        room_id BIGINT UNSIGNED NOT NULL,
        amenity_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (room_id, amenity_id),
        KEY idx_room_amenities_amenity_room (amenity_id, room_id),
        CONSTRAINT fk_room_amenities_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT,
        CONSTRAINT fk_room_amenities_amenity FOREIGN KEY (amenity_id) REFERENCES amenities(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE room_times (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        room_id BIGINT UNSIGNED NOT NULL,
        available_from DATE NOT NULL,
        available_to DATE NOT NULL,
        status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_room_times_room_status_from (room_id, status, available_from),
        CONSTRAINT chk_room_times_range CHECK (available_from < available_to),
        CONSTRAINT fk_room_times_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE attachments (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        uploader_user_id BIGINT UNSIGNED NOT NULL,
        object_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        object_id BIGINT UNSIGNED NOT NULL,
        association_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        position SMALLINT UNSIGNED NOT NULL,
        object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        mime_type VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        size_bytes BIGINT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_attachments_object_key (object_key),
        UNIQUE KEY uq_attachments_target_position (object_type, object_id, association_type, position),
        KEY idx_attachments_target (object_type, object_id),
        KEY idx_attachments_uploader (uploader_user_id),
        CONSTRAINT fk_attachments_uploader FOREIGN KEY (uploader_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE storage_cleanup_tasks (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        reason ENUM('UPLOAD_SAFEGUARD', 'DETACHED_OBJECT') NOT NULL,
        available_at DATETIME(6) NOT NULL,
        locked_at DATETIME(6) NULL,
        lock_expires_at DATETIME(6) NULL,
        locked_by VARCHAR(100) NULL,
        attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_storage_cleanup_tasks_object_key (object_key),
        KEY idx_storage_cleanup_tasks_claim (available_at, lock_expires_at),
        CONSTRAINT chk_storage_cleanup_tasks_lock CHECK (
          (locked_at IS NULL AND lock_expires_at IS NULL AND locked_by IS NULL)
          OR
          (locked_at IS NOT NULL AND lock_expires_at IS NOT NULL AND locked_by IS NOT NULL)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE storage_cleanup_tasks');
    await queryRunner.query('DROP TABLE attachments');
    await queryRunner.query('DROP TABLE room_times');
    await queryRunner.query('DROP TABLE room_amenities');
    await queryRunner.query('DROP TABLE rooms');
    await queryRunner.query('DROP TABLE amenities');
    await queryRunner.query('DROP TABLE room_types');
  }
}
