import { DataSourceOptions } from 'typeorm';
import { DatabaseConfiguration } from '../config/database.config';

/**
 * Waiters allowed per pooled connection before the pool sheds load.
 *
 * mysql2 queues connection requests without bound by default and has no acquire
 * timeout, so a saturated pool would hold every caller — including the readiness
 * probe — until something eventually frees a connection. Bounding the queue turns
 * sustained saturation into a fast, explicit `503 DATABASE_OVERLOADED` instead of an
 * unbounded wait. Four is deliberately generous: it absorbs a normal burst, since one
 * admin room read already acquires three connections at once, while still capping the
 * backlog at a depth a request can plausibly clear.
 */
export const queueDepthPerConnection = 4;

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
    timezone: 'Z',
    entities: overrides.entities ?? [],
    migrations: overrides.migrations ?? [],
    migrationsTableName: overrides.migrationsTableName ?? 'migrations',
    migrationsRun: false,
    synchronize: false,
    logging: false,
    connectTimeout: 5_000,
    extra: {
      connectionLimit: configuration.poolSize,
      queueLimit: configuration.poolSize * queueDepthPerConnection,
    },
  };
}
