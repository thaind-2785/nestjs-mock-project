import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P3-T04 query-plan evidence: the public availability path filters `room_times`
 * by status and date range across all rooms before joining rooms by primary key.
 * Without this index that semijoin scans the whole table; with it MySQL uses a
 * covering index. Additive and reversible, so it never blocks a rollback.
 */
export class AddPublicRoomSearchIndex1788660000000 implements MigrationInterface {
  name = 'AddPublicRoomSearchIndex1788660000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX idx_room_times_status_range ON room_times (status, available_from, available_to, room_id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX idx_room_times_status_range ON room_times',
    );
  }
}
