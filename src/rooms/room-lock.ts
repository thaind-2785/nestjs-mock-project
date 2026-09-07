import { EntityManager } from 'typeorm';
import { Room } from './entities/room.entity';
import { roomsErrors } from './rooms.errors';

/**
 * Every room-scoped mutation locks the physical room first so window, amenity, and
 * Phase 4 booking writes serialize in one order. Callers must already hold a
 * transaction.
 */
export async function lockRoom(
  manager: EntityManager,
  roomId: string,
): Promise<Room> {
  const room = await manager.findOne(Room, {
    where: { id: roomId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!room) throw roomsErrors.roomNotFound();
  return room;
}
