import { AuthIdentity } from '../auth/entities/auth-identity.entity';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { BookingChangeHistory } from '../bookings/entities/booking-change-history.entity';
import { BookingStatusHistory } from '../bookings/entities/booking-status-history.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { IdempotencyKey } from '../common/idempotency/idempotency-key.entity';
import { OutboxEvent } from '../common/outbox/outbox-event.entity';
import { Attachment } from '../files/entities/attachment.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { EmailDelivery } from '../notifications/entities/email-delivery.entity';
import { ExportJob } from '../reports/entities/export-job.entity';
import { ScheduledRun } from '../retention/entities/scheduled-run.entity';
import { Amenity } from '../rooms/entities/amenity.entity';
import { RoomAmenity } from '../rooms/entities/room-amenity.entity';
import { RoomTime } from '../rooms/entities/room-time.entity';
import { RoomType } from '../rooms/entities/room-type.entity';
import { Room } from '../rooms/entities/room.entity';
import { UserRoleHistory } from '../users/entities/user-role-history.entity';
import { UserStatusHistory } from '../users/entities/user-status-history.entity';
import { User } from '../users/entities/user.entity';

/**
 * Every entity the application maps, in one list.
 *
 * It exists for the reason `application-migrations.ts` does: the list was being copied
 * into each integration suite, and a partial copy does not fail where you wrote it. It
 * fails at `DataSource.initialize` with `Entity metadata for User#identities was not
 * found`, because TypeORM resolves relations across the whole registered set - so
 * registering the three entities a test touches pulls in the graph they point at, and
 * naming that graph by hand is a puzzle rather than a decision.
 */
export const applicationEntities = [
  User,
  AuthIdentity,
  AuthSession,
  UserStatusHistory,
  UserRoleHistory,
  RoomType,
  Amenity,
  Room,
  RoomAmenity,
  RoomTime,
  Attachment,
  StorageCleanupTask,
  Booking,
  BookingStatusHistory,
  BookingChangeHistory,
  IdempotencyKey,
  OutboxEvent,
  EmailDelivery,
  ExportJob,
  ScheduledRun,
];
