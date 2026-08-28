import { MigrationInterface, QueryRunner } from 'typeorm';

export class P1T04MigrationProbe1700000000000 implements MigrationInterface {
  name = 'P1T04MigrationProbe1700000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE p1_t04_migration_probe (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        marker VARCHAR(64) NOT NULL,
        created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE p1_t04_migration_probe');
  }
}
