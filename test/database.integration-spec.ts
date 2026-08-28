import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../src/config/database.config';
import { loadRepositoryEnvironment } from '../src/config/environment-file';
import { validateEnvironment } from '../src/config/environment.validation';
import { createTypeOrmOptions } from '../src/database/database.options';
import { P1T04MigrationProbe1700000000000 } from './fixtures/migrations/1700000000000-P1T04MigrationProbe';

jest.setTimeout(30_000);

describe('TypeORM MySQL migration integration', () => {
  let dataSource: DataSource | undefined;
  let adminConnection: mysql.Connection | undefined;
  let disposableDatabase: string | undefined;

  beforeAll(async () => {
    loadRepositoryEnvironment();
    const environment = validateEnvironment(process.env);
    disposableDatabase = `p1_t04_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    const configuration = createDatabaseConfiguration({
      ...environment,
      MYSQL_DATABASE: disposableDatabase,
    });

    try {
      adminConnection = await mysql.createConnection({
        host: environment.MYSQL_HOST,
        port: environment.MYSQL_PORT,
        user: 'root',
        password:
          process.env.MYSQL_ROOT_PASSWORD ?? 'local_mysql_root_change_me',
      });
      await adminConnection.query(
        `CREATE DATABASE \`${disposableDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await adminConnection.query(
        `GRANT ALL PRIVILEGES ON \`${disposableDatabase}\`.* TO '${configuration.username}'@'%'`,
      );
    } catch (error) {
      throw new Error(
        `MySQL integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    dataSource = new DataSource(
      createTypeOrmOptions(configuration, {
        migrations: [P1T04MigrationProbe1700000000000],
        migrationsTableName: 'p1_t04_migrations',
      }),
    );

    try {
      await dataSource.initialize();
    } catch (error) {
      throw new Error(
        `MySQL integration prerequisite unavailable. Start npm run compose:smoke and retry. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  it('connects with synchronize disabled and migrates the disposable fixture up/down', async () => {
    const connection = dataSource as DataSource;
    const tableExists = async (tableName: string): Promise<boolean> => {
      const rows = await connection.query<unknown[]>(
        `
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ?
        `,
        [tableName],
      );
      return rows.length > 0;
    };
    expect(connection.options.synchronize).toBe(false);

    try {
      const applied = await connection.runMigrations();
      expect(applied.map((migration) => migration.name)).toEqual([
        'P1T04MigrationProbe1700000000000',
      ]);
      expect(await tableExists('p1_t04_migration_probe')).toBe(true);

      const columns = await connection.query<Array<{ COLUMN_NAME: string }>>(
        `
          SELECT COLUMN_NAME
          FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'p1_t04_migration_probe'
          ORDER BY ORDINAL_POSITION
        `,
      );
      expect(columns.map((column) => column.COLUMN_NAME)).toEqual([
        'id',
        'marker',
        'created_at',
      ]);

      await connection.undoLastMigration();
      expect(await tableExists('p1_t04_migration_probe')).toBe(false);
    } finally {
      await connection.query('DROP TABLE IF EXISTS p1_t04_migration_probe');
      await connection.query('DROP TABLE IF EXISTS p1_t04_migrations');
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (adminConnection && disposableDatabase) {
      try {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${disposableDatabase}\``,
        );
      } finally {
        await adminConnection.end();
      }
    }
  });
});
