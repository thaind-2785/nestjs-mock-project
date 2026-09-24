process.env.RAILWAY_DEPLOY_IMPORT_ONLY = '1';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deploy,
  migrationCommand,
  readCurrentImage,
} from './railway-deploy.mjs';

/**
 * The deploy decides things, and every decision it makes is one that cannot be observed
 * from a green build: which digest each service ends on, whether the worker moves at all,
 * what happens when readiness never answers. Merging to `main` is the only way to run it
 * for real, which is exactly why it is tested here instead.
 *
 * The fake records every call rather than asserting inside it, so a test states the
 * sequence it expects rather than a count of things that happened.
 */
function railway({ readinessStatuses = [200], currentImages = {} } = {}) {
  const calls = [];
  const images = {
    'service-api': 'ghcr.io/owner/app@sha256:' + 'a'.repeat(64),
    'service-worker': 'ghcr.io/owner/app@sha256:' + 'a'.repeat(64),
    ...currentImages,
  };
  const statuses = [...readinessStatuses];

  const context = {
    token: 'token',
    environmentId: 'env-1',
    services: { api: 'service-api', worker: 'service-worker' },
    image: 'ghcr.io/owner/app@sha256:' + 'b'.repeat(64),
    readinessUrl: 'https://example.test/api/v1/health/ready',
    readinessBudgetMs: 50,
    pollIntervalMs: 1,
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    sleep: async () => {},
    log: (record) => calls.push({ log: record.event }),
    async fetch(url, init) {
      if (url === context.readinessUrl) {
        const status = statuses.length > 1 ? statuses.shift() : statuses[0];
        calls.push({ readiness: status });
        return { ok: true, status };
      }

      const body = JSON.parse(init.body);
      const variables = body.variables;

      if (body.query.includes('serviceInstance(')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              serviceInstance: {
                source: { image: images[variables.serviceId] },
              },
            },
          }),
        };
      }
      if (body.query.includes('serviceInstanceUpdate')) {
        calls.push({
          set: variables.serviceId,
          image: variables.input.source.image,
          preDeploy: variables.input.preDeployCommand ?? null,
        });
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      }
      if (body.query.includes('serviceInstanceDeployV2')) {
        calls.push({ deploy: variables.serviceId });
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      }
      throw new Error('unexpected query');
    },
  };

  return { context, calls };
}

/** Records which auth header each attempt carried, and refuses all but one kind. */
function tokenFake(accepts) {
  const headersSeen = [];
  return {
    headersSeen,
    async fetch(url, init) {
      const kind = init.headers['project-access-token'] ? 'project' : 'account';
      headersSeen.push(kind);
      if (kind !== accepts) return { ok: false, status: 401 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { serviceInstance: { source: { image: 'img' } } },
        }),
      };
    },
  };
}

const NEW = 'ghcr.io/owner/app@sha256:' + 'b'.repeat(64);
const OLD = 'ghcr.io/owner/app@sha256:' + 'a'.repeat(64);

test('moves both services to the same digest, API first', async () => {
  const { context, calls } = railway();

  await deploy(context);

  const sequence = calls.filter((c) => c.set || c.deploy);
  assert.deepEqual(sequence, [
    { set: 'service-api', image: NEW, preDeploy: [migrationCommand] },
    { deploy: 'service-api' },
    { set: 'service-worker', image: NEW, preDeploy: null },
    { deploy: 'service-worker' },
  ]);

  // The API carries the migration and the worker does not. Two pre-deploy commands would
  // be two processes racing to apply the same schema change.
  assert.equal(
    sequence.filter((c) => c.preDeploy).length,
    1,
    'exactly one service runs the migration',
  );
});

test('does not move the worker when the API never becomes ready', async () => {
  const { context, calls } = railway({ readinessStatuses: [503] });

  await assert.rejects(() => deploy(context), /readiness never returned 200/);

  // The worker was never pointed at the new digest, so the two halves of one application
  // did not end up on two revisions of it.
  const workerSets = calls.filter(
    (c) => c.set === 'service-worker' && c.image === NEW,
  );
  assert.equal(workerSets.length, 0);
});

test('restores the previous digest on both services when readiness fails', async () => {
  const { context, calls } = railway({ readinessStatuses: [503] });

  await assert.rejects(() => deploy(context));

  const restored = calls.filter((c) => c.set && c.image === OLD);
  assert.deepEqual(
    restored.map((c) => c.set).sort(),
    ['service-api', 'service-worker'],
    'both services go back, not only the one that failed',
  );

  // And the rollback is re-asserted with its own deploy, not left as written config that
  // nothing acts on: `serviceInstanceUpdate` writes, it does not deploy.
  const deploysAfterRollback = calls
    .slice(calls.findIndex((c) => c.set && c.image === OLD))
    .filter((c) => c.deploy);
  assert.equal(deploysAfterRollback.length, 2);
});

test('waits rather than failing on the first non-200', async () => {
  // A deploy replaces containers asynchronously, so the requests immediately after it
  // legitimately reach the old container, nothing, or a starting one. Treating the first
  // 502 as a failure would roll back every successful deploy.
  const { context, calls } = railway({ readinessStatuses: [502, 503, 200] });

  await deploy(context);

  assert.deepEqual(
    calls.filter((c) => c.readiness).map((c) => c.readiness),
    [502, 503, 200],
  );
});

test('refuses to run when a service has no image to go back to', async () => {
  const { context, calls } = railway({
    currentImages: { 'service-worker': null },
  });

  await assert.rejects(() => deploy(context), /deploy it by hand once/);

  // Nothing was written at all: finding this out before touching anything is the point.
  assert.equal(calls.filter((c) => c.set).length, 0);
});

test('reports a failed rollback instead of reporting success', async () => {
  const { context, calls } = railway({ readinessStatuses: [503] });

  await assert.rejects(() => deploy(context), /readiness never returned 200/);

  // The deploy failed and the rollback could not confirm readiness either. That state
  // needs a person now, so it is said plainly rather than folded into the first failure.
  assert.ok(
    calls.some((c) => c.log === 'deploy_rollback_failed'),
    'a rollback that cannot confirm readiness says so',
  );
});

test('accepts a project token, which is the narrower of the two', async () => {
  const { headersSeen, fetch } = tokenFake('project');
  const { context } = railway();

  await readCurrentImage({ ...context, fetch }, 'service-api');

  // Tried first, and no second attempt: a correctly scoped token is the one that works
  // without the operator knowing Railway has two header conventions.
  assert.deepEqual(headersSeen, ['project']);
});

test('falls back to an account token rather than reporting a bare 401', async () => {
  const { headersSeen, fetch } = tokenFake('account');
  const { context } = railway();

  await readCurrentImage({ ...context, fetch }, 'service-api');

  assert.deepEqual(headersSeen, ['project', 'account']);
});

test('says both were refused when neither works', async () => {
  const { fetch } = tokenFake('neither');
  const { context } = railway();

  await assert.rejects(
    () => readCurrentImage({ ...context, fetch }, 'service-api'),
    // A bare 401 sends somebody to check the token's value. This sends them to check its
    // kind, which is the thing that is actually wrong.
    /both a project and an account token/,
  );
});
