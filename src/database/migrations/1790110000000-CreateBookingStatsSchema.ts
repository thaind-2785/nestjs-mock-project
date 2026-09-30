import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Phase 9 statistics read model (`SPEC-012`, `P9-T02`).
 *
 * One row per booking, holding the latest version the Kafka consumer has applied. It is
 * a projection of `hotel.booking-lifecycle.v1`, not a second copy of `bookings`: it has
 * no foreign key into the transactional tables, so the consumer never takes a lock the
 * booking invariants depend on, and the rebuild command can empty it and replay the
 * topic without touching anything else.
 *
 * `idx_booking_stats_facts_stay` is the report query in index form. The range is on its
 * leading column and every other column the query reads follows, so a report is an index
 * range scan that never reads a table row. `idx_booking_stats_facts_occurred` answers
 * `asOf` - the newest applied event - as a single index lookup. Each applied event costs
 * one write to each; that is the price of a report that does not scan.
 *
 * `down` drops the table. That loses nothing a replay cannot rebuild, which is why it is
 * safe here when it is not for the ledgers.
 */
export class CreateBookingStatsSchema1790110000000 implements MigrationInterface {
  name = 'CreateBookingStatsSchema1790110000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE booking_stats_facts (
        booking_public_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        booking_version BIGINT UNSIGNED NOT NULL,
        status ENUM('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED_BY_USER', 'CANCELLED_BY_ADMIN', 'COMPLETED') NOT NULL,
        room_id BIGINT UNSIGNED NOT NULL,
        room_type_id BIGINT UNSIGNED NOT NULL,
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        price_amount BIGINT UNSIGNED NOT NULL,
        currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        last_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        last_occurred_at DATETIME(6) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (booking_public_id),
        KEY idx_booking_stats_facts_stay (check_in, room_type_id, status, currency, price_amount),
        KEY idx_booking_stats_facts_occurred (last_occurred_at),
        CONSTRAINT chk_booking_stats_facts_range CHECK (check_in < check_out),
        CONSTRAINT chk_booking_stats_facts_version CHECK (booking_version >= 1),
        CONSTRAINT chk_booking_stats_facts_price_safe_integer CHECK (price_amount <= 9007199254740991)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE booking_stats_facts');
  }
}
