import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../config/database.config';
import { loadRepositoryEnvironment } from '../config/environment-file';
import { validateEnvironment } from '../config/environment.validation';
import { applicationEntities } from './application-entities';
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
    entities: applicationEntities,
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
