import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthRbacSchema1788380000000 implements MigrationInterface {
  name = 'CreateAuthRbacSchema1788380000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        email VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        role ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
        status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
        email_verified_at DATETIME(6) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_users_email (email),
        KEY idx_users_status_role (status, role)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE auth_identities (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        provider ENUM('GOOGLE') NOT NULL,
        provider_subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        provider_email VARCHAR(255) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_auth_identities_provider_subject (provider, provider_subject),
        UNIQUE KEY uq_auth_identities_user_provider (user_id, provider),
        CONSTRAINT fk_auth_identities_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE auth_sessions (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        refresh_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        refresh_expires_at DATETIME(6) NOT NULL,
        revoked_at DATETIME(6) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_auth_sessions_user_revoked (user_id, revoked_at),
        KEY idx_auth_sessions_refresh_expires (refresh_expires_at),
        CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE user_status_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        actor_user_id BIGINT UNSIGNED NOT NULL,
        from_status ENUM('ACTIVE', 'INACTIVE') NOT NULL,
        to_status ENUM('ACTIVE', 'INACTIVE') NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_user_status_history_user_created (user_id, created_at),
        KEY idx_user_status_history_actor (actor_user_id),
        CONSTRAINT fk_user_status_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_user_status_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await queryRunner.query(`
      CREATE TABLE user_role_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        actor_type ENUM('USER', 'CLI') NOT NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        from_role ENUM('USER', 'ADMIN') NOT NULL,
        to_role ENUM('USER', 'ADMIN') NOT NULL,
        reason TEXT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY idx_user_role_history_user_created (user_id, created_at),
        KEY idx_user_role_history_actor (actor_user_id),
        CONSTRAINT fk_user_role_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT fk_user_role_history_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE user_role_history');
    await queryRunner.query('DROP TABLE user_status_history');
    await queryRunner.query('DROP TABLE auth_sessions');
    await queryRunner.query('DROP TABLE auth_identities');
    await queryRunner.query('DROP TABLE users');
  }
}
