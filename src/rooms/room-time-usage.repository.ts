import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { emptyRoomTimeUsage, RoomTimeUsage } from './room-time-policy';

export const ROOM_TIME_USAGE_REPOSITORY = Symbol('ROOM_TIME_USAGE_REPOSITORY');

export interface RoomTimeUsageRepository {
  findByRoomTimeIds(
    manager: EntityManager,
    roomTimeIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomTimeUsage>>;
}

@Injectable()
export class ZeroRoomTimeUsageRepository implements RoomTimeUsageRepository {
  findByRoomTimeIds(
    manager: EntityManager,
    roomTimeIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomTimeUsage>> {
    void manager;
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
