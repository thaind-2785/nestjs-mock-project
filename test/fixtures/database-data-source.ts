import { DataSource } from 'typeorm';
import { createDatabaseConfiguration } from '../../src/config/database.config';
import { loadRepositoryEnvironment } from '../../src/config/environment-file';
import { validateEnvironment } from '../../src/config/environment.validation';
import { createTypeOrmOptions } from '../../src/database/database.options';
import { isP1T04DisposableDatabaseName } from '../../src/database/test-database-name';
import { P1T04MigrationProbe1700000000000 } from './migrations/1700000000000-P1T04MigrationProbe';

loadRepositoryEnvironment();

const environment = validateEnvironment(process.env);
if (
  environment.NODE_ENV !== 'test' ||
  !isP1T04DisposableDatabaseName(environment.MYSQL_DATABASE)
) {
  throw new Error(
    'Test-fixture migration commands require NODE_ENV=test and a disposable MYSQL_DATABASE.',
  );
}

const configuration = createDatabaseConfiguration(environment);

// This CLI data source intentionally exposes only the P1-T04 disposable fixture.
// Production migrations will be added by their owning domain slice.
const testMigrationDataSource = new DataSource(
  createTypeOrmOptions(configuration, {
    migrations: [P1T04MigrationProbe1700000000000],
    migrationsTableName: 'p1_t04_migrations',
  }),
);

export default testMigrationDataSource;
