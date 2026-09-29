import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxEventStatus } from '../common/outbox/outbox.enums';
import {
  bookingLifecycleBackoffJitterRatio,
  bookingLifecycleEventTypes,
} from './booking-lifecycle-event.constants';
import type {
  ClaimedLifecycleRow,
  LifecycleFailInput,
  LifecycleFinalizeInput,
  LifecycleRetryInput,
} from './booking-lifecycle-relay.types';

const familyPredicate = `event_type IN (${bookingLifecycleEventTypes.map(() => '?').join(', ')})`;

// 2^30 initial delays is far past any ceiling; the clamp keeps POW finite.
const maximumBackoffExponent = 30;

function placeholders(ids: readonly string[]): string {
  return ids.map(() => '?').join(', ');
}

/**
 * The lifecycle family's SQL after the shared claim: read the claimed rows back, then
 * finalize them by outcome.
 *
 * Every statement is scoped to this family and to the claim token, and addresses a
 * whole batch at once. The token is generated per relay cycle, so a relay whose lease
 * expired and was recovered elsewhere matches nothing and finalizes nothing - the
 * caller learns that from the affected-row count. Each statement touches only
 * `outbox_events`, so there is no second table and no lock order to keep.
 */
@Injectable()
export class BookingLifecycleRelayRepository {
  async readClaimed(
    manager: EntityManager,
    input: LifecycleFinalizeInput,
  ): Promise<ClaimedLifecycleRow[]> {
    if (input.ids.length === 0) return [];
    const rows: Array<{ id: string; payload: unknown; createdAt: Date }> =
      await manager.query(
        `SELECT id, payload, created_at AS createdAt
         FROM outbox_events
         WHERE id IN (${placeholders(input.ids)})
           AND ${familyPredicate}
           AND status = ?
           AND locked_by = ?
         ORDER BY created_at ASC, id ASC`,
        [
          ...input.ids,
          ...bookingLifecycleEventTypes,
          OutboxEventStatus.Processing,
          input.claimToken,
        ],
      );
    return rows.map((row) => ({
      id: row.id,
      // mysql2 already parses a JSON column; a string here would be a driver change.
      payload:
        typeof row.payload === 'string' ? safeParse(row.payload) : row.payload,
      createdAt: new Date(row.createdAt),
    }));
  }

  async markPublished(
    manager: EntityManager,
    input: LifecycleFinalizeInput,
  ): Promise<number> {
    return this.finish(manager, input, {
      status: OutboxEventStatus.Processed,
      assignments: 'processed_at = NOW(6), last_error_code = NULL',
      parameters: [],
    });
  }

  /**
   * Hands a batch back after a failed publish. The attempt stays spent - it is what
   * grows the backoff - but there is no ceiling: a broker outage says nothing about
   * the event (`ADR-0012`). The delay is computed per row by MySQL as the statement
   * runs, from that row's own attempt count, so one statement retries a batch without
   * flattening every row onto the schedule of the newest one. Jitter sits above the
   * base, as in the mail family, and the ceiling bounds the total.
   */
  async markRetry(
    manager: EntityManager,
    input: LifecycleRetryInput,
  ): Promise<number> {
    return this.finish(manager, input, {
      status: OutboxEventStatus.Pending,
      assignments: `available_at = NOW(6) + INTERVAL LEAST(
          FLOOR(? * POW(2, LEAST(GREATEST(attempts - 1, 0), ?)) * (1 + RAND() * ?)),
          ?
        ) * 1000 MICROSECOND,
        last_error_code = ?`,
      parameters: [
        input.backoffInitialMs,
        maximumBackoffExponent,
        bookingLifecycleBackoffJitterRatio,
        input.backoffMaxMs,
        input.errorCode,
      ],
    });
  }

  async markFailed(
    manager: EntityManager,
    input: LifecycleFailInput,
  ): Promise<number> {
    return this.finish(manager, input, {
      status: OutboxEventStatus.Failed,
      assignments: 'failed_at = NOW(6), last_error_code = ?',
      parameters: [input.errorCode],
    });
  }

  private async finish(
    manager: EntityManager,
    input: LifecycleFinalizeInput,
    outcome: {
      status: OutboxEventStatus;
      assignments: string;
      parameters: unknown[];
    },
  ): Promise<number> {
    if (input.ids.length === 0) return 0;
    const result: { affectedRows?: number } = await manager.query(
      `UPDATE outbox_events
       SET status = ?,
           locked_at = NULL,
           lock_expires_at = NULL,
           locked_by = NULL,
           ${outcome.assignments}
       WHERE id IN (${placeholders(input.ids)})
         AND ${familyPredicate}
         AND status = ?
         AND locked_by = ?`,
      [
        outcome.status,
        ...outcome.parameters,
        ...input.ids,
        ...bookingLifecycleEventTypes,
        OutboxEventStatus.Processing,
        input.claimToken,
      ],
    );
    return result.affectedRows ?? 0;
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
