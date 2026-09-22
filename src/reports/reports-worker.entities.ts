import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { Room } from '../rooms/entities/room.entity';
import { RoomType } from '../rooms/entities/room-type.entity';
import { ExportJob } from './entities/export-job.entity';

/**
 * Every entity the export worker reaches through the entity manager.
 *
 * It is a named list rather than an inline argument because the tests have to build
 * their `DataSource` from exactly this set. `autoLoadEntities` only knows about
 * entities some module registered, so one missing here produces a worker that starts
 * cleanly and fails every attempt at runtime with `EntityMetadataNotFoundError` -
 * which is precisely what happened with `Room` and `RoomType`, and precisely what a
 * suite that registers `applicationEntities` instead can never catch.
 *
 * `Room` and `RoomType` are registered here rather than by importing `RoomsModule`,
 * which would bring HTTP controllers into a context that has none.
 */
export const reportsWorkerEntities = [
  OutboxEvent,
  ExportJob,
  StorageCleanupTask,
  Room,
  RoomType,
];
