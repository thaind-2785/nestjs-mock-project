import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AuthIdentity } from '../auth/entities/auth-identity.entity';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { BookingChangeHistory } from '../bookings/entities/booking-change-history.entity';
import { BookingStatusHistory } from '../bookings/entities/booking-status-history.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { IdempotencyKey } from '../bookings/entities/idempotency-key.entity';
import { OutboxEvent } from '../bookings/entities/outbox-event.entity';
import { createDatabaseConfiguration } from '../config/database.config';
import { loadRepositoryEnvironment } from '../config/environment-file';
import { validateEnvironment } from '../config/environment.validation';
import { UserRoleHistory } from '../users/entities/user-role-history.entity';
import { UserStatusHistory } from '../users/entities/user-status-history.entity';
import { User } from '../users/entities/user.entity';
import { Amenity } from '../rooms/entities/amenity.entity';
import { RoomAmenity } from '../rooms/entities/room-amenity.entity';
import { RoomTime } from '../rooms/entities/room-time.entity';
import { RoomType } from '../rooms/entities/room-type.entity';
import { Room } from '../rooms/entities/room.entity';
import { Attachment } from '../files/entities/attachment.entity';
import { StorageCleanupTask } from '../files/entities/storage-cleanup-task.entity';
import { EmailDelivery } from '../notifications/entities/email-delivery.entity';
import { ExportJob } from '../reports/entities/export-job.entity';
import { createTypeOrmOptions } from './database.options';
import { CreateAuthRbacSchema1788380000000 } from './migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from './migrations/1788490000000-CreateRoomCatalogSchema';
import { CreateBookingCoreSchema1788580000000 } from './migrations/1788580000000-CreateBookingCoreSchema';
import { CreateNotificationDeliverySchema1789370000000 } from './migrations/1789370000000-CreateNotificationDeliverySchema';
import { CreateEmailSendAttemptSchema1789460000000 } from './migrations/1789460000000-CreateEmailSendAttemptSchema';
import { AddDeliveryBacklogIndex1789550000000 } from './migrations/1789550000000-AddDeliveryBacklogIndex';
import { CreateRoomExportSchema1789640000000 } from './migrations/1789640000000-CreateRoomExportSchema';

loadRepositoryEnvironment();
const environment = validateEnvironment(process.env);

export default new DataSource(
  createTypeOrmOptions(createDatabaseConfiguration(environment), {
    entities: [
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
    ],
    migrations: [
      CreateAuthRbacSchema1788380000000,
      CreateRoomCatalogSchema1788490000000,
      CreateBookingCoreSchema1788580000000,
      CreateNotificationDeliverySchema1789370000000,
      CreateEmailSendAttemptSchema1789460000000,
      AddDeliveryBacklogIndex1789550000000,
      CreateRoomExportSchema1789640000000,
    ],
  }),
);
