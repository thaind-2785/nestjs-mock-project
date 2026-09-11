import { EntityManager } from 'typeorm';
import { RoomTimeUsage } from './room-time-policy';

export const ROOM_TIME_USAGE_REPOSITORY = Symbol('ROOM_TIME_USAGE_REPOSITORY');

export interface RoomTimeUsageRepository {
  /**
   * Must return one entry per requested ID, counted through `manager` so the
   * answer belongs to the caller's transaction and its room lock. Callers treat
   * a missing entry as a contract violation, never as zero usage.
   */
  findByRoomTimeIds(
    manager: EntityManager,
    roomTimeIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomTimeUsage>>;
}
