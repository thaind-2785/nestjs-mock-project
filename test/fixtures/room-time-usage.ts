import { EntityManager } from 'typeorm';
import {
  emptyRoomTimeUsage,
  RoomTimeUsage,
} from '../../src/rooms/room-time-policy';
import type { RoomTimeUsageRepository } from '../../src/rooms/room-time-usage.repository';

/**
 * Reports every requested window as unused.
 *
 * Production reads real booking counts, so this double exists only for suites
 * that exercise room-time policy or room search on a database without the
 * booking schema. Usage-driven rules are covered against the real repository in
 * `booking-foundation.integration-spec.ts`.
 */
export class UnusedRoomTimeUsageRepository implements RoomTimeUsageRepository {
  findByRoomTimeIds(
    _manager: EntityManager,
    roomTimeIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomTimeUsage>> {
    return Promise.resolve(
      new Map(
        roomTimeIds.map((roomTimeId) => [
          roomTimeId,
          { ...emptyRoomTimeUsage },
        ]),
      ),
    );
  }
}
