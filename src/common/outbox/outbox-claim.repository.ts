import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from './outbox.enums';
import type {
  ClaimedRow,
  EligibleRow,
  OutboxClaim,
  OutboxClaimInput,
  OutboxEventTypeAllowlist,
  OutboxReleaseInput,
} from './outbox-claim.types';

/**
 * Builds the event-type restriction every statement in this protocol carries.
 *
 * An empty allowlist throws rather than producing `IN ()`, which MySQL rejects, and
 * rather than being quietly dropped, which would produce a dispatcher that claims
 * everything - the exact failure this whole mechanism exists to prevent.
 */
function eventTypePredicate(eventTypes: OutboxEventTypeAllowlist): {
  predicate: string;
  parameters: string[];
} {
  if (eventTypes.length === 0) {
    throw new Error('An outbox claim requires at least one event type');
  }
  return {
    predicate: `event_type IN (${eventTypes.map(() => '?').join(', ')})`,
    parameters: [...eventTypes],
  };
}

/**
 * Orders the rows one batch claimed. SQL sorts only by `available_at`, because that
 * is the order the claim index already stores and anything more makes the read sort -
 * and lock - the whole backlog. Events sharing an `available_at` are therefore
 * selected in index order, which for PENDING rows reduces to a random UUID, so this
 * is a stable order within a batch rather than a total order across batches.
 */
function compareEligible(left: EligibleRow, right: EligibleRow): number {
  return (
    left.availableAt.getTime() - right.availableAt.getTime() ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

/**
 * The claim protocol, and nothing else.
 *
 * Eligible rows are selected with `FOR UPDATE SKIP LOCKED` so a second dispatcher
 * steps over rows the first already holds instead of blocking behind them, and the
 * whole claim commits before any Redis call: a dispatcher that dies mid-handoff must
 * leave a lease that expires, not a row nobody can find.
 *
 * Every statement is scoped to the caller's own event types, in SQL, before `LIMIT`.
 * That placement is the invariant: a dispatcher that filtered a claimed batch in Node
 * would already hold leases on the other family's rows, making them unavailable to
 * their real owner until expiry. Filtering before the lock means the other family is
 * never touched at all.
 *
 * `claimBatchIsolation` is load-bearing, not decoration. The recovery statement can
 * only use the `status` part of the claim index and filters `lock_expires_at` per
 * row, so it examines every `PROCESSING` row. Measured on MySQL 8.4 with a thousand
 * live leases, that scan holds 10 locks at READ COMMITTED and over a thousand at
 * REPEATABLE READ, where a worker finalizing an unrelated row it legitimately holds
 * then waits out its lock timeout. READ COMMITTED releases the locks on rows the
 * filter rejected; that release is the whole reason the scan is safe.
 */
@Injectable()
export class OutboxClaimRepository {
  async claimBatch(
    manager: EntityManager,
    input: OutboxClaimInput,
  ): Promise<OutboxClaim[]> {
    // Two statements, not one predicate with OR, and each ordered only by what the
    // claim index already provides. A locking read that has to sort reads - and so
    // locks - every eligible row before LIMIT applies, which makes the first
    // dispatcher lock the whole backlog and leaves `SKIP LOCKED` nothing to skip to.
    // Ordered by the index, each dispatcher locks its own batch and no more.
    //
    // Abandoned claims are collected first. A dispatcher that filled its batch with
    // new arrivals every time would never look at them, and a steady stream of
    // arrivals - exactly what a recovering provider produces - would strand a crashed
    // worker's events in PROCESSING for as long as the backlog lasted.
    const types = eventTypePredicate(input.eventTypes);
    const expired = await this.selectEligible(manager, {
      predicate: `${types.predicate} AND status = ? AND lock_expires_at <= NOW(6)`,
      parameters: [...types.parameters, OutboxEventStatus.Processing],
      limit: input.batchSize,
    });
    const remaining = input.batchSize - expired.length;
    const due =
      remaining > 0
        ? await this.selectEligible(manager, {
            predicate: `${types.predicate} AND status = ? AND available_at <= NOW(6)`,
            parameters: [...types.parameters, OutboxEventStatus.Pending],
            limit: remaining,
          })
        : [];
    const eligible = [...expired, ...due].sort(compareEligible);
    if (eligible.length === 0) return [];

    const ids = eligible.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    // The allowlist is repeated here although these ids came from a select that
    // already applied it. The two statements are what a reviewer reads as the claim,
    // and a predicate that is true only because of another statement further up is
    // one edit away from not being true at all.
    await manager.query(
      `UPDATE outbox_events
       SET status = ?,
           locked_at = NOW(6),
           lock_expires_at = NOW(6) + INTERVAL ? MICROSECOND,
           locked_by = ?,
           attempts = attempts + 1
       WHERE id IN (${placeholders})
         AND ${types.predicate}`,
      [
        OutboxEventStatus.Processing,
        input.leaseMs * 1_000,
        input.claimToken,
        ...ids,
        ...types.parameters,
      ],
    );

    // Read the incremented attempt back rather than assuming it: the job carries the
    // attempt, and a worker accepts a job only when the row still agrees with it.
    const claimed: ClaimedRow[] = await manager.query(
      `SELECT id, attempts FROM outbox_events WHERE id IN (${placeholders})`,
      ids,
    );
    const attempts = new Map(
      claimed.map((row) => [row.id, Number(row.attempts)]),
    );
    return ids.map((id) => ({ id, attempt: attempts.get(id) ?? 0 }));
  }

  private async selectEligible(
    manager: EntityManager,
    input: { predicate: string; parameters: unknown[]; limit: number },
  ): Promise<EligibleRow[]> {
    const rows: EligibleRow[] = await manager.query(
      `SELECT id, available_at AS availableAt, created_at AS createdAt
       FROM outbox_events
       WHERE ${input.predicate}
       ORDER BY available_at ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [...input.parameters, input.limit],
    );
    return rows;
  }

  /**
   * Hands a claim back after the queue refused it.
   *
   * The attempt is given back with it. `attempts` is the delivery budget, and a job
   * that never reached a worker is not a delivery: without this, an hour of Redis
   * downtime would spend all five attempts of every waiting event and the queue
   * coming back would turn each one terminally FAILED without a single message ever
   * having been offered to a provider.
   *
   * The predicate is the other half: only the dispatcher whose token and attempt
   * still match may release the row, so a dispatcher acting on a claim that has
   * already expired and been recovered by someone else changes nothing. The retry
   * time is computed by the database as the statement runs, so time spent waiting on
   * an unreachable queue is not silently subtracted from the backoff.
   */
  async release(
    manager: EntityManager,
    input: OutboxReleaseInput,
  ): Promise<boolean> {
    const releaseTypes = eventTypePredicate(input.eventTypes);
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE outbox_events
       SET status = ?,
           locked_at = NULL,
           lock_expires_at = NULL,
           locked_by = NULL,
           available_at = NOW(6) + INTERVAL ? MICROSECOND,
           last_error_code = ?,
           attempts = attempts - 1
       WHERE id = ?
         AND ${releaseTypes.predicate}
         AND status = ?
         AND locked_by = ?
         AND attempts = ?`,
      [
        OutboxEventStatus.Pending,
        input.retryInMs * 1_000,
        input.errorCode,
        input.id,
        ...releaseTypes.parameters,
        OutboxEventStatus.Processing,
        input.claimToken,
        input.attempt,
      ],
    );
    return (result.affectedRows ?? 0) > 0;
  }
}
