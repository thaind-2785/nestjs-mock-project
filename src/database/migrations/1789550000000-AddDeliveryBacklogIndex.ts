import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Covers the per-template backlog aggregate the operator alerts on.
 *
 * The sampler groups `email_deliveries` by `(template_key, status)` over the whole
 * table, and it does so deliberately: these are lifetime counts, so a time window
 * would make a number fall merely because the clock crossed a boundary. That leaves
 * the scan itself as the only thing worth making cheaper, and `PR #13` asked for it.
 *
 * `idx_email_deliveries_status_created` cannot serve the query - it leads on `status`,
 * while the grouping leads on `template_key` - so the aggregate read the clustered
 * index end to end and grouped through a temporary table. This index leads on the
 * grouping columns in the order the query already asks for, and carries no column the
 * query does not select, so the read is a covering index scan with neither row lookups
 * nor a sort.
 *
 * The cost is on the write path and is bounded: one secondary-index insert per
 * delivery, plus one index update when the row leaves `PENDING` for its outcome.
 * `status` is in the key, so that transition does move the entry. Both are paid once
 * per mail rather than once per alert poll, and no other write touches these columns.
 */
export class AddDeliveryBacklogIndex1789550000000 implements MigrationInterface {
  name = 'AddDeliveryBacklogIndex1789550000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX idx_email_deliveries_template_status ON email_deliveries (template_key, status)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Unlike the schema migrations under it, this one destroys no evidence: it is an
    // access path, not a fact. It reverts unconditionally, and the aggregate falls
    // back to the scan it did before.
    await queryRunner.query(
      'DROP INDEX idx_email_deliveries_template_status ON email_deliveries',
    );
  }
}
