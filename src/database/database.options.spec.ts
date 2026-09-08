import type { MigrationInterface } from 'typeorm';
import { createDatabaseConfiguration } from '../config/database.config';
import { validateEnvironment } from '../config/environment.validation';
import { createTypeOrmOptions } from './database.options';
import { isP1T04DisposableDatabaseName } from './test-database-name';

/**
 * Built through the real validator rather than an object literal, so the fixture is
 * a set of raw variables a deployment could actually provide and every other
 * variable keeps its validated default.
 */
function databaseConfiguration(poolSize: string) {
  return createDatabaseConfiguration(
    validateEnvironment({
      NODE_ENV: 'test',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_DATABASE: 'hotel_test',
      MYSQL_USER: 'hotel_app',
      MYSQL_PASSWORD: 'test-password',
      MYSQL_POOL_SIZE: poolSize,
    }),
  );
}

describe('createTypeOrmOptions', () => {
  it('creates a non-synchronizing MySQL configuration', () => {
    const database = databaseConfiguration('12');

    expect(createTypeOrmOptions(database)).toEqual({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'hotel_app',
      password: 'test-password',
      database: 'hotel_test',
      charset: 'utf8mb4',
      timezone: 'Z',
      entities: [],
      migrations: [],
      migrationsTableName: 'migrations',
      migrationsRun: false,
      synchronize: false,
      logging: false,
      connectTimeout: 5000,
      extra: { connectionLimit: 12, queueLimit: 48 },
    });
  });

  it('allows the CLI to provide only its explicit migration set', () => {
    // The option accepts migration classes, so the fixture is one too: a plain
    // object would not prove that a CLI-supplied set passes through unchanged.
    class FixtureMigration implements MigrationInterface {
      public up(): Promise<void> {
        return Promise.resolve();
      }

      public down(): Promise<void> {
        return Promise.resolve();
      }
    }
    const database = databaseConfiguration('8');

    expect(
      createTypeOrmOptions(database, { migrations: [FixtureMigration] }),
    ).toMatchObject({
      migrations: [FixtureMigration],
      timezone: 'Z',
      extra: { connectionLimit: 8, queueLimit: 32 },
      synchronize: false,
      migrationsRun: false,
    });
  });
});

describe('isP1T04DisposableDatabaseName', () => {
  it('accepts only namespaced disposable fixture schemas', () => {
    expect(isP1T04DisposableDatabaseName('p1_t04_123_abc')).toBe(true);
    expect(isP1T04DisposableDatabaseName('hotel_management')).toBe(false);
    expect(isP1T04DisposableDatabaseName('p1_t05_123_abc')).toBe(false);
  });
});
