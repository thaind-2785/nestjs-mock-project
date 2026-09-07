import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { emptyRoomTimeUsage, RoomTimeUsage } from './room-time-policy';

export const ROOM_TIME_USAGE_REPOSITORY = Symbol('ROOM_TIME_USAGE_REPOSITORY');

export interface RoomTimeUsageRepository {
  /**
   * Must return one entry per requested ID. Phase 4 replaces this port with
   * locked booking and change-history counts read through `manager`; callers
   * treat a missing entry as a contract violation, never as zero usage.
   */
  findByRoomTimeIds(
    manager: EntityManager,
    roomTimeIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomTimeUsage>>;
}

@Injectable()
export class ZeroRoomTimeUsageRepository implements RoomTimeUsageRepository {
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
