import { EntityManager } from 'typeorm';
import { Room } from './entities/room.entity';
import { roomsErrors } from './rooms.errors';

/**
 * The locking read is also the mutation snapshot, so it hydrates every mutable
 * column plus `version` and deliberately omits audit timestamps and relations no
 * caller uses. The return type states that omission, so a future caller that needs
 * a timestamp fails to compile instead of silently reading `undefined`.
 */
export type LockedRoom = Omit<Room, 'createdAt' | 'updatedAt' | 'roomType'>;

/**
 * Every room-scoped mutation locks the physical room first so window, amenity, and
 * Phase 4 booking writes serialize in one order. Callers must already hold a
 * transaction.
 */
export async function lockRoom(
  manager: EntityManager,
  roomId: string,
): Promise<LockedRoom> {
  const room = await manager.findOne(Room, {
    where: { id: roomId },
    select: {
      id: true,
      roomTypeId: true,
      roomNumber: true,
      bedCount: true,
      viewCode: true,
      basePriceAmount: true,
      currency: true,
      status: true,
      version: true,
    },
    lock: { mode: 'pessimistic_write' },
  });
  if (!room) throw roomsErrors.roomNotFound();
  return room;
}
