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
    'minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
  mailpit:
    'axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24',
};

test('pins the dependency-only Compose topology to reviewed images', () => {
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    Object.keys(expectedImages).sort(),
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
  assert.match(
    compose.services.minio.environment.MINIO_ROOT_PASSWORD,
    /^\$\{MINIO_ROOT_PASSWORD:-/,
  );
});

test('starts every readiness dependency before the CI verification gate', () => {
  assert.deepEqual(ciReadinessServices, ['mysql', 'redis', 'minio']);
  for (const service of ciReadinessServices) {
    assert.ok(compose.services[service].healthcheck?.test);
  }
});
