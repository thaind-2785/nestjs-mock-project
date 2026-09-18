import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

/**
 * The repository keeps two hand-written lists of the same migration stack:
 * `src/database/data-source.ts`, which `npm run migration:run` uses for local and
 * deployed databases, and `test/fixtures/application-migrations.ts`, which every
 * suite that builds a disposable database uses.
 *
 * Only the second one is exercised. `REVIEW-037` found `CreateEmailSendAttemptSchema`
 * registered in the fixture and missing from the data source: every test created
 * `email_send_attempts` and no deployment ever would, so the redrive guard would have
 * thrown on a real database while the whole gate stayed green. A green gate cannot
 * see a list the gate does not read, which is exactly why this check is static.
 */

const MIGRATIONS_DIRECTORY = 'src/database/migrations';
const DATA_SOURCE = 'src/database/data-source.ts';
const TEST_FIXTURE = 'test/fixtures/application-migrations.ts';

/** A migration class name ends in the 13-digit timestamp that orders the stack. */
const MIGRATION_CLASS = /\b([A-Za-z][A-Za-z0-9_]*?\d{13})\b/g;

function declaredMigrations() {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .flatMap((name) => {
      const source = readFileSync(`${MIGRATIONS_DIRECTORY}/${name}`, 'utf8');
      const declaration = source.match(
        /export class ([A-Za-z][A-Za-z0-9_]*?\d{13})\s+[^{]*implements MigrationInterface/,
      );
      assert.ok(
        declaration,
        `${MIGRATIONS_DIRECTORY}/${name} declares no migration class; a migration file that exports nothing recognisable cannot be registered anywhere`,
      );
      return [declaration[1]];
    })
    .sort();
}

/**
 * Reads the identifiers inside one array literal. Registration order is the stack
 * order, so this deliberately preserves it rather than sorting.
 */
function registeredMigrations(path, arrayAnchor) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf(arrayAnchor);
  assert.notEqual(
    start,
    -1,
    `${path} no longer contains ${arrayAnchor}; this check cannot see the list any more and must be updated rather than deleted`,
  );
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  assert.ok(
    open !== -1 && close > open,
    `${path}: ${arrayAnchor} is not an array literal`,
  );
  return [...source.slice(open, close).matchAll(MIGRATION_CLASS)].map(
    (match) => match[1],
  );
}

test('every migration on disk is registered for both deployments and tests', () => {
  const declared = declaredMigrations();
  const production = registeredMigrations(DATA_SOURCE, 'migrations:');
  const fixture = registeredMigrations(TEST_FIXTURE, 'applicationMigrations');

  assert.deepEqual(
    [...production].sort(),
    declared,
    `${DATA_SOURCE} does not register exactly the migrations in ${MIGRATIONS_DIRECTORY}. A migration missing here runs in every test and in no deployment.`,
  );
  assert.deepEqual(
    [...fixture].sort(),
    declared,
    `${TEST_FIXTURE} does not register exactly the migrations in ${MIGRATIONS_DIRECTORY}.`,
  );
});

test('both lists apply the same migrations in the same order', () => {
  const production = registeredMigrations(DATA_SOURCE, 'migrations:');
  const fixture = registeredMigrations(TEST_FIXTURE, 'applicationMigrations');

  // Order is not cosmetic: a migration that runs before the schema it alters fails,
  // and the suites peel a known number of migrations off the top of this stack.
  assert.deepEqual(
    production,
    fixture,
    'the deployed migration order and the tested migration order have diverged; the tests would prove nothing about the database a deployment builds',
  );
});

test('registration order matches the timestamp order the class names declare', () => {
  const registered = registeredMigrations(DATA_SOURCE, 'migrations:');
  const timestamps = registered.map((name) => Number(name.slice(-13)));
  const ascending = [...timestamps].sort((a, b) => a - b);

  assert.deepEqual(
    timestamps,
    ascending,
    'a migration is registered out of timestamp order; TypeORM would apply it in this order and a later-numbered migration would alter a table that does not exist yet',
  );
});
