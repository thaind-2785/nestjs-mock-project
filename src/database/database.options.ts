import { DataSourceOptions } from 'typeorm';
import { DatabaseConfiguration } from '../config/database.config';

export function createTypeOrmOptions(
  configuration: DatabaseConfiguration,
  overrides: Pick<
    DataSourceOptions,
    'entities' | 'migrations' | 'migrationsTableName'
  > = {},
): DataSourceOptions {
  return {
    type: 'mysql',
    host: configuration.host,
    port: configuration.port,
    username: configuration.username,
    password: configuration.password,
    database: configuration.database,
    charset: 'utf8mb4',
    entities: overrides.entities ?? [],
    migrations: overrides.migrations ?? [],
    migrationsTableName: overrides.migrationsTableName ?? 'migrations',
    migrationsRun: false,
    synchronize: false,
    logging: false,
    connectTimeout: 5_000,
  };
}
