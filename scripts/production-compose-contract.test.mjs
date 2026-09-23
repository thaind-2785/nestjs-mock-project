import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

/**
 * The rules that only matter once a file is run on a machine holding real data.
 *
 * Each of these is a one-line edit away from being wrong, and none of them fails a build,
 * a test run or a deploy. They fail later, on the host, at the moment the damage is done.
 */
const production = parse(readFileSync('compose.production.yaml', 'utf8'));
const caddyfile = readFileSync('Caddyfile', 'utf8');

const applicationServices = ['api', 'worker', 'migrate'];

test('declares no database, so a redeploy cannot destroy the data', () => {
  // The whole reason the production database is managed and outside this file. A MySQL
  // service here is a MySQL service that `docker compose down -v` deletes, and it would
  // be holding the only copy this project has.
  assert.equal(production.services.mysql, undefined);
  assert.equal(production.volumes.mysql_data, undefined);

  for (const name of Object.keys(production.services)) {
    const image = production.services[name].image ?? '';
    assert.doesNotMatch(
      image,
      /mysql|mariadb|percona/i,
      `${name} must not run a database on the application host`,
    );
  }
});

test('builds nothing on the host', () => {
  // A host that builds is a host that can produce an artifact CI never tested, from
  // whatever source happened to be on its disk.
  for (const [name, service] of Object.entries(production.services)) {
    assert.equal(
      service.build,
      undefined,
      `${name} must run a published image, not build one`,
    );
    assert.ok(service.image, `${name} must name an image`);
  }
});

test('runs one published artifact for every application process', () => {
  const images = applicationServices.map(
    (name) => production.services[name].image,
  );

  // The same variable in all three, so the API, the worker and the migration that runs
  // ahead of them cannot be different revisions of the same application.
  assert.equal(new Set(images).size, 1);

  // `:?` and not a default. A deploy that forgets to resolve the tag must stop, not
  // silently start whatever `latest` points at today.
  assert.match(images[0], /^\$\{APP_IMAGE:\?/);
  assert.doesNotMatch(images[0], /:latest/);
});

test('pins every third-party image by digest', () => {
  // A tag is a pointer somebody else can move. A digest is the bytes.
  for (const [name, service] of Object.entries(production.services)) {
    if (applicationServices.includes(name)) continue;
    assert.match(
      service.image,
      /@sha256:[0-9a-f]{64}$/,
      `${name} must be pinned by digest`,
    );
  }
});

test('publishes only the proxy to the host', () => {
  // Redis with no password, MinIO with its root credentials and Mailpit with every
  // message the demonstration produced are all on this machine. Exactly one service is
  // allowed to answer the internet, and it is the one holding the certificate.
  for (const [name, service] of Object.entries(production.services)) {
    if (name === 'caddy') continue;
    assert.equal(
      service.ports,
      undefined,
      `${name} must not publish a port on a host reachable from the internet`,
    );
  }
  assert.deepEqual(production.services.caddy.ports, ['80:80', '443:443']);
});

test('keeps the migration a deliberate one-shot', () => {
  const migrate = production.services.migrate;

  // Behind a profile and never restarted: it is invoked by name, before the running
  // containers are replaced, so a failed migration leaves the previous revision serving.
  assert.deepEqual(migrate.profiles, ['migrate']);
  assert.equal(migrate.restart, 'no');
  // `node` directly rather than through a package manager: the image ships no npm, which
  // is what removed eleven of the fourteen findings its first scan produced.
  assert.deepEqual(migrate.command, [
    'node',
    'node_modules/typeorm/cli.js',
    'migration:run',
    '-d',
    'dist/database/data-source.js',
  ]);

  // Never `migration:revert`. `AGENTS.md` makes migrations the source of truth, and an
  // automatic revert on a failed deploy is how a partial migration becomes data loss.
  const text = readFileSync('compose.production.yaml', 'utf8');
  assert.doesNotMatch(text, /migration:revert/);
});

test('takes its secrets from the host, never from the file', () => {
  const text = readFileSync('compose.production.yaml', 'utf8');

  for (const name of applicationServices) {
    assert.equal(production.services[name].env_file, '.env');
  }

  // Interpolated from the host environment with `:?`, so a missing value stops the stack
  // instead of starting MinIO on a default nobody chose.
  assert.match(
    production.services.minio.environment.MINIO_ROOT_USER,
    /^\$\{OBJECT_STORAGE_ACCESS_KEY:\?/,
  );
  assert.match(
    production.services.minio.environment.MINIO_ROOT_PASSWORD,
    /^\$\{OBJECT_STORAGE_SECRET_KEY:\?/,
  );

  // No literal that looks like a credential, however tempting during a debugging session.
  // Matched on whole YAML lines rather than anywhere in the text: the first version of
  // this assertion fired on `${OBJECT_STORAGE_SECRET_KEY:?}`, because the variable's own
  // name ends in `_KEY` and is followed by `:?` - it accused the very interpolation it
  // exists to require.
  const assignments = text
    .split('\n')
    .filter((line) => /^\s+[A-Z_]*(PASSWORD|SECRET|TOKEN|KEY):/.test(line));
  assert.ok(assignments.length > 0, 'expected credential-shaped keys to exist');
  for (const line of assignments) {
    const value = line.slice(line.indexOf(':') + 1).trim();
    assert.match(
      value,
      /^\$\{/,
      `credential-shaped value must be interpolated, not written: ${line.trim()}`,
    );
  }
});

test('terminates TLS for one named host and proxies to the application', () => {
  // The hostname comes from the environment rather than being written in: the same file
  // serves whatever name the host was given, and the name lives in one place.
  assert.match(caddyfile, /\{\$PUBLIC_HOSTNAME\}/);
  assert.match(caddyfile, /reverse_proxy api:3000/);
  assert.match(caddyfile, /reverse_proxy mailpit:8025/);
  assert.match(caddyfile, /Strict-Transport-Security/);
});
