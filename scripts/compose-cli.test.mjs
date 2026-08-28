import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposeCli } from './compose-cli.mjs';
import { createPersistenceProbe } from './compose-smoke-policy.mjs';

function result(stdout, status = 0) {
  return { error: null, status, stdout, stderr: '' };
}

test('prefers a Docker Compose v2 plugin', () => {
  const calls = [];
  const composeCli = resolveComposeCli((executable, args) => {
    calls.push([executable, ...args]);
    return result('Docker Compose version v2.40.3');
  });

  assert.deepEqual(composeCli, {
    executable: 'docker',
    prefix: ['compose'],
    label: 'docker compose',
  });
  assert.deepEqual(calls, [['docker', 'compose', 'version']]);
});

test('falls back to a standalone Docker Compose v2-compatible CLI', () => {
  const calls = [];
  const composeCli = resolveComposeCli((executable, args) => {
    calls.push([executable, ...args]);
    return executable === 'docker'
      ? result('', 1)
      : result('Docker Compose version 5.1.0');
  });

  assert.equal(composeCli.executable, 'docker-compose');
  assert.deepEqual(calls, [
    ['docker', 'compose', 'version'],
    ['docker-compose', 'version'],
  ]);
});

test('rejects installed Compose clients older than v2', () => {
  assert.throws(
    () =>
      resolveComposeCli(() =>
        result('docker-compose version 1.29.2, build 5becea4c'),
      ),
    /Docker Compose v2 or newer is unavailable/,
  );
});

test('reports when neither Compose command is installed', () => {
  assert.throws(
    () =>
      resolveComposeCli(() => ({
        error: new Error('ENOENT'),
        status: null,
        stdout: '',
        stderr: '',
      })),
    /Docker Compose v2 or newer is unavailable/,
  );
});

test('uses a unique namespaced key for each persistence probe', () => {
  const firstIds = ['first-key', 'first-value'];
  const secondIds = ['second-key', 'second-value'];
  const first = createPersistenceProbe(() => firstIds.shift());
  const second = createPersistenceProbe(() => secondIds.shift());

  assert.deepEqual(first, {
    key: 'p1:t03:persistence-probe:first-key',
    value: 'first-value',
  });
  assert.deepEqual(second, {
    key: 'p1:t03:persistence-probe:second-key',
    value: 'second-value',
  });
  assert.notEqual(first.key, second.key);
});
