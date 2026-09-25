import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { ciReadinessServices } from './compose-ci-policy.mjs';

const compose = parse(readFileSync('compose.yaml', 'utf8'));
const expectedImages = {
  mysql:
    'mysql:8.4.11@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
  redis:
    'redis:7.4.11-alpine3.21@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf',
  minio:
    'ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9',
  mailpit:
    'axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24',
};

test('pins every third-party Compose image to a reviewed digest', () => {
  // The application services joined this file in `P8-T02` and are deliberately not in
  // `expectedImages`: they are built from the Dockerfile beside them, not pulled, so
  // there is no digest to pin and pinning one would mean pinning the project to its own
  // past.
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    [...Object.keys(expectedImages), 'api', 'worker'].sort(),
  );

  for (const [serviceName, image] of Object.entries(expectedImages)) {
    assert.equal(compose.services[serviceName].image, image);
    assert.equal(compose.services[serviceName].restart, 'unless-stopped');
    assert.ok(compose.services[serviceName].healthcheck?.test);
    assert.ok(compose.services[serviceName].volumes?.length > 0);
    assert.ok(
      compose.services[serviceName].ports.every((port) =>
        String(port).startsWith('127.0.0.1:'),
      ),
    );
  }
});

test('keeps the application behind a profile, on one image, waiting for its dependencies', () => {
  for (const serviceName of ['api', 'worker']) {
    const service = compose.services[serviceName];

    // Behind a profile, so `docker compose up` still means "start the dependencies" for
    // anybody debugging the application from their terminal, and does not take port 3000
    // away from the process they are debugging.
    assert.deepEqual(service.profiles, ['app']);

    // One image name for both. Compose otherwise derives a name per service and builds
    // the same context twice, which is two artifacts in a design whose entire argument is
    // that there is one. Measured, not assumed: before this line the two containers ran
    // `<project>-api` and `<project>-worker`.
    assert.equal(service.image, 'hotel-management:local');
    assert.equal(service.build.context, '.');

    // `.env.example` is the floor and is committed; `.env` is the developer's override
    // and may be absent. Order matters - the last file wins - and so does `required`.
    assert.deepEqual(service.env_file, [
      { path: '.env.example', required: true },
      { path: '.env', required: false },
    ]);

    // Started only once every dependency answers, so a failed `up` is a failure rather
    // than a container restarting behind a database that was not listening yet.
    for (const dependency of ['mysql', 'redis', 'minio', 'mailpit']) {
      assert.equal(service.depends_on[dependency].condition, 'service_healthy');
    }
  }

  // The one line that makes "one artifact, two processes" true rather than intended.
  assert.deepEqual(compose.services.worker.command, ['node', 'dist/worker']);

  // The worker has no HTTP surface, so it declares no healthcheck. Asserted rather than
  // left as an omission: a fabricated port to probe would report health it never checked.
  assert.equal(compose.services.worker.healthcheck, undefined);
});

test('declares persistent volumes and disables external update checks', () => {
  assert.deepEqual(Object.keys(compose.volumes).sort(), [
    'mailpit_data',
    'minio_data',
    'mysql_data',
    'redis_data',
  ]);
  assert.equal(compose.services.minio.environment.MINIO_UPDATE, 'off');
  assert.equal(
    compose.services.mailpit.environment.MP_DISABLE_VERSION_CHECK,
    'true',
  );
  assert.match(
    compose.services.mysql.environment.MYSQL_PASSWORD,
    /^\$\{MYSQL_PASSWORD:-/,
  );
  assert.ok(
    compose.services.mysql.command.includes('--default-time-zone=+00:00'),
  );
  assert.match(
    compose.services.minio.environment.MINIO_ROOT_PASSWORD,
    /^\$\{MINIO_ROOT_PASSWORD:-/,
  );
});

test('starts every readiness dependency before the CI verification gate', () => {
  assert.deepEqual(ciReadinessServices, ['mysql', 'redis', 'minio', 'mailpit']);
  for (const service of ciReadinessServices) {
    assert.ok(compose.services[service].healthcheck?.test);
  }
});
