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
import { createTypeOrmOptions } from './database.options';
import { CreateAuthRbacSchema1788380000000 } from './migrations/1788380000000-CreateAuthRbacSchema';

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
    ],
    migrations: [CreateAuthRbacSchema1788380000000],
  }),
);
