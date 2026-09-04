import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AuthIdentity } from '../auth/entities/auth-identity.entity';
import { AuthSession } from '../auth/entities/auth-session.entity';
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
import { createTypeOrmOptions } from './database.options';
import { CreateAuthRbacSchema1788380000000 } from './migrations/1788380000000-CreateAuthRbacSchema';
import { CreateRoomCatalogSchema1788490000000 } from './migrations/1788490000000-CreateRoomCatalogSchema';

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
    ],
    migrations: [
      CreateAuthRbacSchema1788380000000,
      CreateRoomCatalogSchema1788490000000,
    ],
  }),
);
