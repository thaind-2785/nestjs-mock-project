import { createDatabaseConfiguration } from '../config/database.config';
import { createTypeOrmOptions } from './database.options';
import { isP1T04DisposableDatabaseName } from './test-database-name';

describe('createTypeOrmOptions', () => {
  it('creates a non-synchronizing MySQL configuration', () => {
    const database = createDatabaseConfiguration({
      NODE_ENV: 'test',
      PORT: 3000,
      SWAGGER_ENABLED: false,
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: 3306,
      MYSQL_DATABASE: 'hotel_test',
      MYSQL_USER: 'hotel_app',
      MYSQL_PASSWORD: 'test-password',
    });

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
    });
  });

  it('allows the CLI to provide only its explicit migration set', () => {
    const migration = { name: 'fixture' };
    const database = createDatabaseConfiguration({
      NODE_ENV: 'test',
      PORT: 3000,
      SWAGGER_ENABLED: false,
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: 3306,
      MYSQL_DATABASE: 'hotel_test',
      MYSQL_USER: 'hotel_app',
      MYSQL_PASSWORD: 'test-password',
    });

    expect(
      createTypeOrmOptions(database, { migrations: [migration] }),
    ).toMatchObject({
      migrations: [migration],
      timezone: 'Z',
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
