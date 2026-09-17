import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { IdempotencyKeyStatus } from '../../bookings/entities/booking.enums';
import { IdempotencyKey } from '../../bookings/entities/idempotency-key.entity';
import { idempotencyErrors } from './idempotency.errors';
import type {
  IdempotencyCompletion,
  IdempotencyLockInput,
} from './idempotency.types';

/**
 * The shared retry contract: one row per actor, operation and key, locked for the
 * duration of the transaction that is allowed to fulfil it.
 *
 * It is one implementation on purpose. Two endpoints with separately written insert
 * and lock statements would eventually differ in a way no test names - a missing
 * `ON DUPLICATE KEY`, a lock taken after the first write instead of before it - and
 * the symptom would be duplicate durable work under concurrency, which is the one
 * thing this table exists to prevent.
 *
 * The caller owns the `EntityManager` because the lock has to be held by the same
 * transaction that performs the work and stores its response; a manager injected here
 * could escape that transaction.
 */
@Injectable()
export class IdempotencyRepository {
  /**
   * Claims the row and returns it locked.
   *
   * The insert comes first and is idempotent, so the lock always has a row to take
   * and two concurrent callers serialize on it rather than racing to create it. A
   * fingerprint that disagrees is the same key used for a different request, which is
   * a client bug rather than a retry, and it is refused before any work begins.
   */
  async lock(
    manager: EntityManager,
    input: IdempotencyLockInput,
  ): Promise<IdempotencyKey> {
    await manager.query(
      `INSERT INTO idempotency_keys
        (actor_user_id, operation, idempotency_key, request_fingerprint, status, response_status, response_body, expires_at)
       VALUES (?, ?, ?, ?, 'PENDING', NULL, NULL, ?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [
        input.actorUserId,
        input.operation,
        input.idempotencyKey,
        input.fingerprint,
        new Date(Date.now() + input.retentionHours * 3_600_000),
      ],
    );
    const row = await manager.findOneOrFail(IdempotencyKey, {
      where: {
        actorUserId: input.actorUserId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (row.requestFingerprint !== input.fingerprint) {
      throw idempotencyErrors.keyReused();
    }
    return row;
  }

  /** Stores the exact response a later replay must return, byte for byte. */
  async complete(
    manager: EntityManager,
    idempotencyId: string,
    completion: IdempotencyCompletion,
  ): Promise<void> {
    await manager.update(IdempotencyKey, idempotencyId, {
      status: IdempotencyKeyStatus.Completed,
      responseStatus: completion.responseStatus,
      responseBody: completion.responseBody as QueryDeepPartialEntity<
        Record<string, unknown>
      >,
    });
  }
}
