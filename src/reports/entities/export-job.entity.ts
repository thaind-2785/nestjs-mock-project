import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { ExportJobStatus } from './export-job.enums';

/**
 * One administrator's request for a room catalogue snapshot.
 *
 * The state checks below are in the database rather than only in the service because
 * this row is written by two processes on different schedules - the API creates it,
 * the worker finishes it - and the invariant worth enforcing is not "the code is
 * careful" but "a completed job has a result and a failed job does not". A partially
 * written completion is the shape that would hand an administrator a download URL for
 * an object that was never uploaded.
 */
@Entity({ name: 'export_jobs' })
@Index('uq_export_jobs_outbox_event', ['outboxEventId'], { unique: true })
@Index('idx_export_jobs_owner', ['requestedBy', 'createdAt', 'id'])
@Index('idx_export_jobs_operations', ['status', 'updatedAt', 'id'])
@Check(
  'chk_export_jobs_state_shape',
  "(`status` IN ('QUEUED', 'PROCESSING') AND `object_key` IS NULL AND `row_count` IS NULL AND `file_size_bytes` IS NULL AND `content_sha256` IS NULL AND `completed_at` IS NULL AND `expires_at` IS NULL AND `failed_at` IS NULL) OR (`status` = 'COMPLETED' AND `object_key` IS NOT NULL AND `row_count` IS NOT NULL AND `file_size_bytes` IS NOT NULL AND `content_sha256` IS NOT NULL AND `started_at` IS NOT NULL AND `completed_at` IS NOT NULL AND `expires_at` IS NOT NULL AND `failed_at` IS NULL AND `last_error_code` IS NULL) OR (`status` = 'FAILED' AND `object_key` IS NULL AND `row_count` IS NULL AND `file_size_bytes` IS NULL AND `content_sha256` IS NULL AND `completed_at` IS NULL AND `expires_at` IS NULL AND `failed_at` IS NOT NULL AND `last_error_code` IS NOT NULL)",
)
@Check(
  'chk_export_jobs_started_before_completed',
  '`started_at` IS NULL OR `completed_at` IS NULL OR `completed_at` >= `started_at`',
)
@Check(
  'chk_export_jobs_result_bounds',
  '(`row_count` IS NULL OR (`row_count` >= 0 AND `row_count` <= 9007199254740991)) AND (`file_size_bytes` IS NULL OR (`file_size_bytes` >= 0 AND `file_size_bytes` <= 9007199254740991))',
)
export class ExportJob extends MutableEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'requested_by', type: 'bigint', unsigned: true })
  requestedBy!: string;

  /**
   * Proof that exactly one durable trigger exists for this job. The unique constraint
   * is what makes it proof: two jobs sharing an outbox event would be two workers
   * generating from one claim.
   */
  @Column({ name: 'outbox_event_id', type: 'char', length: 36 })
  outboxEventId!: string;

  @Column({
    type: 'enum',
    enum: ExportJobStatus,
    default: ExportJobStatus.Queued,
  })
  status!: ExportJobStatus;

  /**
   * The normalized filter snapshot, stored once and never reread from the client.
   * It is application-validated data, never interpolated into SQL.
   */
  @Column({ type: 'json' })
  filters!: Record<string, unknown>;

  /**
   * Server-generated and never returned to a client. It is absent from logs and queue
   * payloads too: the object is private, and the key is the only thing between a
   * presigned URL and the bucket.
   */
  @Column({ name: 'object_key', type: 'varchar', length: 512, nullable: true })
  objectKey!: string | null;

  @Column({ name: 'row_count', type: 'bigint', unsigned: true, nullable: true })
  rowCount!: string | null;

  @Column({
    name: 'file_size_bytes',
    type: 'bigint',
    unsigned: true,
    nullable: true,
  })
  fileSizeBytes!: string | null;

  @Column({
    name: 'content_sha256',
    type: 'char',
    length: 64,
    nullable: true,
  })
  contentSha256!: string | null;

  @Column({
    name: 'started_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  startedAt!: Date | null;

  @Column({
    name: 'completed_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  completedAt!: Date | null;

  /**
   * When the result stops being downloadable. The API compares it against database
   * time rather than the process clock, so a skewed API host cannot extend a result's
   * life past what the cleanup Phase 7 adds will act on.
   */
  @Column({
    name: 'expires_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  expiresAt!: Date | null;

  @Column({ name: 'failed_at', type: 'datetime', precision: 6, nullable: true })
  failedAt!: Date | null;

  /** A stable classification an administrator may read; never provider text. */
  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;
}
