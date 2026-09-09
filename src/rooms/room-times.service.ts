import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DatabaseConnectionService } from '../database/database-connection.service';
import {
  CreateRoomTimeDto,
  UpdateRoomTimeDto,
} from './dto/room-time-request.dto';
import { AdminRoomTimeResponseDto } from './dto/room-time-response.dto';
import { RoomTime } from './entities/room-time.entity';
import { RoomTimeStatus } from './entities/room.enums';
import { Room } from './entities/room.entity';
import { lockRoom } from './room-lock';
import {
  assertRoomTimeDeleteAllowed,
  assertRoomTimeRange,
  assertRoomTimeUpdateAllowed,
  emptyRoomTimeUsage,
  RoomTimeState,
  RoomTimeUsage,
} from './room-time-policy';
import { ROOM_TIME_USAGE_REPOSITORY } from './room-time-usage.repository';
import type { RoomTimeUsageRepository } from './room-time-usage.repository';
import { hasDefinedUpdate } from './room-version';
import { isDatabaseError, roomsErrors } from './rooms.errors';

@Injectable()
export class RoomTimesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly databaseConnection: DatabaseConnectionService,
    @Inject(ROOM_TIME_USAGE_REPOSITORY)
    private readonly usageRepository: RoomTimeUsageRepository,
  ) {}

  async create(
    roomId: string,
    body: CreateRoomTimeDto,
  ): Promise<AdminRoomTimeResponseDto> {
    // Resolve the effective status once so the overlap check and the insert can
    // never disagree through the column default.
    const candidate: RoomTimeState = {
      availableFrom: body.availableFrom,
      availableTo: body.availableTo,
      status: body.status ?? RoomTimeStatus.Active,
    };
    assertRoomTimeRange(candidate);
    await this.databaseConnection.ensureInitialized();
    return this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      await assertNoActiveOverlap(manager, roomId, candidate);
      const roomTime = await manager.save(
        manager.create(RoomTime, { roomId, ...candidate }),
      );
      return toAdminRoomTimeResponse(roomTime, emptyRoomTimeUsage);
    });
  }

  // Informational admin list: parent existence, windows, and usage are read
  // without a transaction, so this is not a decision snapshot and must not be
  // reused as booking authorization input.
  async list(roomId: string): Promise<AdminRoomTimeResponseDto[]> {
    await this.databaseConnection.ensureInitialized();
    const manager = this.dataSource.manager;
    const roomExists = await manager.exists(Room, { where: { id: roomId } });
    if (!roomExists) throw roomsErrors.roomNotFound();
    const roomTimes = await manager.find(RoomTime, {
      where: { roomId },
      order: { availableFrom: 'ASC', id: 'ASC' },
    });
    if (!roomTimes.length) return [];
    const usageByRoomTime = await this.usageRepository.findByRoomTimeIds(
      manager,
      roomTimes.map(({ id }) => id),
    );
    return roomTimes.map((roomTime) =>
      toAdminRoomTimeResponse(
        roomTime,
        requireUsage(usageByRoomTime, roomTime.id),
      ),
    );
  }

  async update(
    roomId: string,
    roomTimeId: string,
    body: UpdateRoomTimeDto,
  ): Promise<AdminRoomTimeResponseDto> {
    if (!hasDefinedUpdate(body)) throw roomsErrors.emptyUpdate();
    await this.databaseConnection.ensureInitialized();
    return this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      const roomTime = await findLockedRoomTime(manager, roomId, roomTimeId);
      const usage = await this.loadUsage(manager, roomTimeId);
      const next: RoomTimeState = {
        availableFrom: body.availableFrom ?? roomTime.availableFrom,
        availableTo: body.availableTo ?? roomTime.availableTo,
        status: body.status ?? roomTime.status,
      };
      assertRoomTimeUpdateAllowed(roomTime, next, usage);
      await assertNoActiveOverlap(manager, roomId, next, roomTime.id);

      roomTime.availableFrom = next.availableFrom;
      roomTime.availableTo = next.availableTo;
      roomTime.status = next.status;
      const saved = await manager.save(roomTime);
      return toAdminRoomTimeResponse(saved, usage);
    });
  }

  async delete(roomId: string, roomTimeId: string): Promise<void> {
    await this.databaseConnection.ensureInitialized();
    try {
      await this.dataSource.transaction(async (manager) => {
        await lockRoom(manager, roomId);
        const roomTime = await findLockedRoomTime(manager, roomId, roomTimeId);
        assertRoomTimeDeleteAllowed(await this.loadUsage(manager, roomTimeId));
        await manager.remove(roomTime);
      });
    } catch (error) {
      // Phase 4 booking foreign keys make this branch observable if the usage
      // port and the constraint ever disagree; the contract stays a 409.
      if (isDatabaseError(error, 'ER_ROW_IS_REFERENCED_2')) {
        throw roomsErrors.roomTimeHasHistory();
      }
      throw error;
    }
  }

  private async loadUsage(
    manager: EntityManager,
    roomTimeId: string,
  ): Promise<RoomTimeUsage> {
    const usages = await this.usageRepository.findByRoomTimeIds(manager, [
      roomTimeId,
    ]);
    return requireUsage(usages, roomTimeId);
  }
}

// Unknown usage must block a mutation, never permit one: an absent entry means
// the port failed its contract, not that the window is unused.
function requireUsage(
  usages: ReadonlyMap<string, RoomTimeUsage>,
  roomTimeId: string,
): RoomTimeUsage {
  const usage = usages.get(roomTimeId);
  if (!usage) {
    throw new Error(`Missing room-time usage for window ${roomTimeId}`);
  }
  return usage;
}

async function findLockedRoomTime(
  manager: EntityManager,
  roomId: string,
  roomTimeId: string,
): Promise<RoomTime> {
  const roomTime = await manager.findOne(RoomTime, {
    where: { id: roomTimeId, roomId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!roomTime) throw roomsErrors.roomTimeNotFound();
  return roomTime;
}

async function assertNoActiveOverlap(
  manager: EntityManager,
  roomId: string,
  candidate: RoomTimeState,
  excludedRoomTimeId?: string,
): Promise<void> {
  if (candidate.status !== RoomTimeStatus.Active) return;
  const builder = manager
    .getRepository(RoomTime)
    .createQueryBuilder('roomTime')
    .select('roomTime.id')
    .where('roomTime.room_id = :roomId', { roomId })
    .andWhere('roomTime.status = :status', {
      status: RoomTimeStatus.Active,
    })
    .andWhere('roomTime.available_from < :availableTo', {
      availableTo: candidate.availableTo,
    })
    .andWhere('roomTime.available_to > :availableFrom', {
      availableFrom: candidate.availableFrom,
    })
    .setLock('pessimistic_write')
    // Existence question: one matched row is enough, and it keeps `FOR UPDATE`
    // off every other overlapping window.
    .limit(1);
  if (excludedRoomTimeId) {
    builder.andWhere('roomTime.id <> :excludedRoomTimeId', {
      excludedRoomTimeId,
    });
  }
  if (await builder.getOne()) throw roomsErrors.roomTimeOverlap();
}

function toAdminRoomTimeResponse(
  roomTime: RoomTime,
  usage: RoomTimeUsage,
): AdminRoomTimeResponseDto {
  return {
    id: roomTime.id,
    roomId: roomTime.roomId,
    availableFrom: roomTime.availableFrom,
    availableTo: roomTime.availableTo,
    status: roomTime.status,
    usage: { ...usage },
    createdAt: roomTime.createdAt.toISOString(),
    updatedAt: roomTime.updatedAt.toISOString(),
  };
}
