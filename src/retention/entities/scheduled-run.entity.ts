import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MutableEntity } from '../../database/entities/base.entity';
import { ScheduledRunStatus } from './scheduled-run.enums';

/**
 * One task's attempt at one window, and the record of what it deleted.
 *
 * This table is the singleton mechanism, not a log of one. The unique key on
 * `(task_name, scheduled_for)` means the insert is the election: replicas racing the
 * same window produce one winner and N-1 duplicate-key failures. A lock could pick a
 * winner too, but it could not leave this behind - a run whose process died is visible
 * here as a claimed row past its lease, where a released lock would be indistinguishable
 * from a run that never started.
 *
 * It is also the only durable evidence that data was deleted, which is why it is
 * deliberately not self-cleaning. A retention job that prunes its own history is a job
 * whose history nobody can audit.
 */
@Entity({ name: 'scheduled_runs' })
@Index('uq_scheduled_runs_window', ['taskName', 'scheduledFor'], {
  unique: true,
})
@Index('idx_scheduled_runs_recoverable', ['status', 'lockExpiresAt'])
@Index('idx_scheduled_runs_history', ['taskName', 'scheduledFor'])
@Check(
  'chk_scheduled_runs_lock_shape',
  '(`locked_by` IS NULL AND `lock_expires_at` IS NULL) OR (`locked_by` IS NOT NULL AND `lock_expires_at` IS NOT NULL)',
)
// A claimed row may carry `last_error_code`: it is the previous attempt's, kept for
// the same reason a pending outbox event keeps one - the next operator to look needs
// to know why this window is on its second try.
@Check(
  'chk_scheduled_runs_state_shape',
  "(`status` = 'CLAIMED' AND `locked_by` IS NOT NULL AND `finished_at` IS NULL) OR (`status` = 'SUCCEEDED' AND `locked_by` IS NULL AND `finished_at` IS NOT NULL AND `last_error_code` IS NULL) OR (`status` = 'FAILED' AND `locked_by` IS NULL AND `finished_at` IS NOT NULL AND `last_error_code` IS NOT NULL)",
)
@Check(
  'chk_scheduled_runs_finished_after_started',
  '`finished_at` IS NULL OR `finished_at` >= `started_at`',
)
export class ScheduledRun extends MutableEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  id!: string;

  @Column({ name: 'task_name', type: 'varchar', length: 64 })
  taskName!: string;

  /**
   * The instant the local day began, from the database clock.
   *
   * It is the window's identity rather than a timestamp of anything that happened, so
   * two replicas whose own clocks disagree still compete for the same row.
   */
  @Column({ name: 'scheduled_for', type: 'datetime', precision: 6 })
  scheduledFor!: Date;

  @Column({ type: 'enum', enum: ScheduledRunStatus })
  status!: ScheduledRunStatus;

  /**
   * The claim token of the replica that owns this run, and the predicate every
   * mutation carries. Reassigned on recovery, which is why it is mutable.
   */
  @Column({ name: 'locked_by', type: 'char', length: 36, nullable: true })
  lockedBy!: string | null;

  @Column({
    name: 'lock_expires_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  lockExpiresAt!: Date | null;

  @Column({ type: 'tinyint', unsigned: true })
  attempts!: number;

  @Column({ name: 'started_at', type: 'datetime', precision: 6 })
  startedAt!: Date;

  @Column({
    name: 'finished_at',
    type: 'datetime',
    precision: 6,
    nullable: true,
  })
  finishedAt!: Date | null;

  /**
   * How many rows this run deleted, per table.
   *
   * Counts only. The ledger records that data was deleted and how much, which is the
   * audit trail a destructive job owes; it never records what the data was.
   */
  @Column({ name: 'deleted_counts', type: 'json', nullable: true })
  deletedCounts!: Record<string, number> | null;

  @Column({
    name: 'last_error_code',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  lastErrorCode!: string | null;
}
