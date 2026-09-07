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
import { roomsErrors } from './rooms.errors';

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
    assertRoomTimeRange(body);
    await this.databaseConnection.ensureInitialized();
    return this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      await assertNoActiveOverlap(manager, roomId, body);
      const roomTime = await manager.save(
        manager.create(RoomTime, {
          roomId,
          availableFrom: body.availableFrom,
          availableTo: body.availableTo,
          status: body.status,
        }),
      );
      return toAdminRoomTimeResponse(roomTime, emptyRoomTimeUsage);
    });
  }

  async list(roomId: string): Promise<AdminRoomTimeResponseDto[]> {
    await this.databaseConnection.ensureInitialized();
    const manager = this.dataSource.manager;
    const roomExists = await manager.exists(Room, { where: { id: roomId } });
    if (!roomExists) throw roomsErrors.roomNotFound();
    const roomTimes = await manager.find(RoomTime, {
      where: { roomId },
      order: { availableFrom: 'ASC', id: 'ASC' },
    });
    const usageByRoomTime = await this.usageRepository.findByRoomTimeIds(
      manager,
      roomTimes.map(({ id }) => id),
    );
    return roomTimes.map((roomTime) =>
      toAdminRoomTimeResponse(
        roomTime,
        usageByRoomTime.get(roomTime.id) ?? emptyRoomTimeUsage,
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
      const usage = await loadUsage(this.usageRepository, manager, roomTimeId);
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
    await this.dataSource.transaction(async (manager) => {
      await lockRoom(manager, roomId);
      const roomTime = await findLockedRoomTime(manager, roomId, roomTimeId);
      const usage = await loadUsage(this.usageRepository, manager, roomTimeId);
      assertRoomTimeDeleteAllowed(usage);
      await manager.remove(roomTime);
    });
  }
}

async function lockRoom(manager: EntityManager, roomId: string): Promise<Room> {
  const room = await manager.findOne(Room, {
    where: { id: roomId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!room) throw roomsErrors.roomNotFound();
  return room;
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
    .setLock('pessimistic_write');
  if (excludedRoomTimeId) {
    builder.andWhere('roomTime.id <> :excludedRoomTimeId', {
      excludedRoomTimeId,
    });
  }
  if (await builder.getOne()) throw roomsErrors.roomTimeOverlap();
}

async function loadUsage(
  repository: RoomTimeUsageRepository,
  manager: EntityManager,
  roomTimeId: string,
): Promise<RoomTimeUsage> {
  const usages = await repository.findByRoomTimeIds(manager, [roomTimeId]);
  return usages.get(roomTimeId) ?? emptyRoomTimeUsage;
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
