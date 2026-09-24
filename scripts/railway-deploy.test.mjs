process.env.RAILWAY_DEPLOY_IMPORT_ONLY = '1';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deploy,
  migrationCommand,
  readCurrentImage,
} from './railway-deploy.mjs';

/**
 * A platform that behaves the way the real one does, which the first version of this fake
 * did not.
 *
 * `REVIEW-045` found the gap: Railway keeps the outgoing revision serving until the
 * incoming one is healthy, so readiness answers `200` immediately after a deploy - from
 * the container being replaced. The old fake answered `200` too, and that was recorded as
 * the pass case, so every test agreed with a deploy that had verified nothing.
 *
 * Here the liveness endpoint reports which revision is answering and only changes once the
 * deployment reaches `SUCCESS`. A test that wants a failure makes the platform fail;
 * nothing passes because a stale container was polite.
 */
const OLD = 'ghcr.io/owner/app@sha256:' + 'a'.repeat(64);
const NEW = 'ghcr.io/owner/app@sha256:' + 'b'.repeat(64);
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function railway({
  apiStatuses = ['SUCCESS'],
  workerStatuses = ['SUCCESS'],
  currentImages = {},
  readinessStatuses = [200],
  revisionFollowsDeployment = true,
} = {}) {
  const calls = [];
  const images = {
    'service-api': OLD,
    'service-worker': OLD,
    ...currentImages,
  };
  const pending = {
    'service-api': [...apiStatuses],
    'service-worker': [...workerStatuses],
  };
  const deployedAt = {};
  const readiness = [...readinessStatuses];
  let liveRevision = OLD_SHA;

  const context = {
    token: 'token',
    environmentId: 'env-1',
    projectId: 'project-1',
    revision: NEW_SHA,
    services: { api: 'service-api', worker: 'service-worker' },
    image: NEW,
    readinessUrl: 'https://example.test/api/v1/health/ready',
    livenessUrl: 'https://example.test/api/v1/health/live',
    readinessBudgetMs: 200,
    deploymentBudgetMs: 200,
    pollIntervalMs: 1,
    now: (() => {
      let t = 1_000_000;
      return () => (t += 10);
    })(),
    sleep: async () => {},
    log: (record) => calls.push({ log: record.event }),

    async fetch(url, init) {
      if (url === context.livenessUrl) {
        calls.push({ liveness: liveRevision });
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', revision: liveRevision }),
        };
      }
      if (url === context.readinessUrl) {
        const status = readiness.length > 1 ? readiness.shift() : readiness[0];
        calls.push({ readiness: status });
        return { ok: true, status };
      }

      const body = JSON.parse(init.body);
      const variables = body.variables;
      const reply = (data) => ({
        ok: true,
        status: 200,
        json: async () => ({ data }),
      });

      if (body.query.includes('serviceInstance(')) {
        return reply({
          serviceInstance: { source: { image: images[variables.serviceId] } },
        });
      }
      if (body.query.includes('serviceInstanceUpdate')) {
        calls.push({
          set: variables.serviceId,
          image: variables.input.source.image,
          preDeploy: variables.input.preDeployCommand ?? null,
        });
        images[variables.serviceId] = variables.input.source.image;
        return reply({});
      }
      if (body.query.includes('serviceInstanceDeployV2')) {
        calls.push({ deploy: variables.serviceId });
        deployedAt[variables.serviceId] = context.now();
        return reply({});
      }
      if (body.query.includes('deployments(')) {
        const serviceId = variables.input.serviceId;
        const queue = pending[serviceId];
        const status = queue.length > 1 ? queue.shift() : queue[0];
        calls.push({ status: `${serviceId}:${status}` });

        // The revision only changes when the platform says the deployment succeeded -
        // which is the behaviour the old fake was missing.
        if (
          status === 'SUCCESS' &&
          revisionFollowsDeployment &&
          serviceId === 'service-api'
        ) {
          liveRevision =
            images['service-api'] === NEW ? context.revision : OLD_SHA;
        }
        return reply({
          deployments: {
            edges: [
              {
                node: {
                  id: `dep-${serviceId}`,
                  status,
                  createdAt: new Date(
                    deployedAt[serviceId] ?? context.now(),
                  ).toISOString(),
                },
              },
            ],
          },
        });
      }
      throw new Error('unexpected query: ' + body.query.slice(0, 40));
    },
  };

  return { context, calls };
}

const writes = (calls) => calls.filter((c) => c.set || c.deploy);

test('moves both services to the same digest, API first', async () => {
  const { context, calls } = railway();

  await deploy(context);

  assert.deepEqual(writes(calls), [
    { set: 'service-api', image: NEW, preDeploy: [migrationCommand] },
    { deploy: 'service-api' },
    { set: 'service-worker', image: NEW, preDeploy: null },
    { deploy: 'service-worker' },
  ]);
});

test('waits for the revision to change, not for any 200', async () => {
  // The defect `REVIEW-045` found: the outgoing container answers readiness `200` while
  // the new one is still starting, so a check that asks only "is something healthy" passes
  // before anything has happened.
  const { context, calls } = railway();

  await deploy(context);

  const seen = calls.filter((c) => c.liveness).map((c) => c.liveness);
  assert.ok(seen.includes(NEW_SHA), 'the new revision must be observed');
  assert.ok(
    calls.findIndex((c) => c.liveness === NEW_SHA) <
      calls.findIndex((c) => c.set === 'service-worker'),
    'the worker must not move until the API is serving the new revision',
  );
});

test('fails when the old revision keeps answering', async () => {
  // A migration that fails stops the deployment and leaves the previous revision serving.
  // Readiness still answers 200 - from the container that was never replaced.
  const { context } = railway({ revisionFollowsDeployment: false });

  await assert.rejects(
    () => deploy(context),
    /the deployed revision never became/,
  );
});

test('fails when the platform reports the deployment failed', async () => {
  const { context, calls } = railway({ apiStatuses: ['BUILDING', 'FAILED'] });

  await assert.rejects(() => deploy(context), /deployment FAILED/);

  // And the worker was never touched: a failed schema change must not leave the two halves
  // of one application on two revisions.
  assert.equal(calls.filter((c) => c.set === 'service-worker').length, 0);
});

test('waits through the platform states that are not terminal', async () => {
  const { context, calls } = railway({
    apiStatuses: ['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS'],
  });

  await deploy(context);

  assert.deepEqual(
    calls
      .filter((c) => c.status?.startsWith('service-api'))
      .map((c) => c.status),
    [
      'service-api:QUEUED',
      'service-api:BUILDING',
      'service-api:DEPLOYING',
      'service-api:SUCCESS',
    ],
  );
});

test('verifies the worker deployment too, and rolls both back when it fails', async () => {
  // The worker has no HTTP surface, so the platform's own view is the only thing that can
  // say it started. Before `REVIEW-045` nothing checked it at all.
  const { context, calls } = railway({ workerStatuses: ['CRASHED'] });

  await assert.rejects(() => deploy(context), /deployment CRASHED/);

  const restored = calls.filter((c) => c.set && c.image === OLD);
  assert.deepEqual(
    restored.map((c) => c.set).sort(),
    ['service-api', 'service-worker'],
    'both services go back, because both had been moved',
  );
});

test('does not restart a service it never moved', async () => {
  // A failure before the worker is touched must not redeploy a healthy worker, killing
  // in-flight export and mail work for something it had no part in.
  //
  // The API's own deployments succeed here, so the rollback runs to completion rather
  // than dying on the first service - which is what makes the worker's absence from it
  // observable. An earlier version of this test failed the API's deployment instead, and
  // the rollback never reached the worker for reasons unrelated to the rule.
  const { context, calls } = railway({ revisionFollowsDeployment: false });

  await assert.rejects(
    () => deploy(context),
    /the deployed revision never became/,
  );

  assert.deepEqual(
    calls.filter((c) => c.set && c.image === OLD).map((c) => c.set),
    ['service-api'],
    'only the service that was moved is restored',
  );
});

test('refuses a tag before anything is written', async () => {
  const { context, calls } = railway();
  context.image = 'ghcr.io/owner/app:main';

  await assert.rejects(() => deploy(context), /must name a digest, not a tag/);

  // The platform caches what a floating tag resolved to, so deploying one re-runs an
  // hour-old image and reports success. Nothing was written, not even a read.
  assert.equal(calls.filter((c) => c.set).length, 0);
});

test('refuses to run when a service has no image to go back to', async () => {
  const { context, calls } = railway({
    currentImages: { 'service-worker': null },
  });

  await assert.rejects(() => deploy(context), /deploy it by hand once/);

  assert.equal(calls.filter((c) => c.set).length, 0);
});

test('reports rolledBack false when the rollback could not be confirmed', async () => {
  // The field an operator or an alert keys on. Reporting `true` here would stand the alert
  // down for the state where neither the deploy nor the restore worked.
  // The worker recovers on the restore, so the rollback's own deployments succeed - and
  // then readiness still refuses. That is the state worth distinguishing: things were put
  // back and the result is still not serving.
  const { context } = railway({
    workerStatuses: ['CRASHED', 'SUCCESS'],
    readinessStatuses: [503],
  });

  const error = await deploy(context).then(
    () => null,
    (caught) => caught,
  );

  assert.ok(error);
  assert.equal(error.rolledBack, false);
});

test('reports rolledBack true when the previous revision is serving again', async () => {
  const { context } = railway({ workerStatuses: ['CRASHED', 'SUCCESS'] });

  const error = await deploy(context).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error.rolledBack, true);
});

test('aborts and rolls back when the platform answers 200 with an error body', async () => {
  // Railway reports most real failures - unknown service id, insufficient scope, schema
  // drift - as HTTP 200 with an `errors` array. That handler had no test at all, and
  // deleting it left every case green.
  const { context, calls } = railway();
  const inner = context.fetch;
  let deployCalls = 0;
  context.fetch = async (url, init) => {
    if (
      init?.body?.includes('serviceInstanceDeployV2') &&
      deployCalls++ === 0
    ) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          errors: [{ message: 'Not Authorized', path: ['serviceInstance'] }],
        }),
      };
    }
    return inner(url, init);
  };

  const error = await deploy(context).then(
    () => null,
    (caught) => caught,
  );

  assert.match(error.message, /Not Authorized/);
  // The message carries the platform's words and not the variables it was sent, which
  // would echo the service identifiers back into the log.
  assert.doesNotMatch(error.message, /service-api|project-1|env-1/);
  assert.ok(calls.some((c) => c.set && c.image === OLD));
});

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
          data: { serviceInstance: { source: { image: OLD } } },
        }),
      };
    },
  };
}

test('accepts a project token, which is the narrower of the two', async () => {
  const { headersSeen, fetch } = tokenFake('project');
  const { context } = railway();

  await readCurrentImage({ ...context, fetch }, 'service-api');

  assert.deepEqual(headersSeen, ['project']);
});

test('falls back to an account token rather than reporting a bare 401', async () => {
  const { headersSeen, fetch } = tokenFake('account');
  const { context } = railway();

  await readCurrentImage({ ...context, fetch }, 'service-api');

  assert.deepEqual(headersSeen, ['project', 'account']);
});

test('remembers the header that worked instead of re-probing', async () => {
  // Probing both on every call made one deploy twelve requests, six guaranteed `401`s -
  // and asserted the fallback once, at its declaration, rather than across the deploy.
  const { headersSeen, fetch } = tokenFake('account');
  const { context } = railway();
  const shared = { ...context, fetch };

  await readCurrentImage(shared, 'service-api');
  await readCurrentImage(shared, 'service-worker');

  assert.deepEqual(headersSeen, ['project', 'account', 'account']);
});

test('reports a 403 as a scope problem, not a token-kind problem', async () => {
  // A wrong service or environment id is understood and refused. Retrying it under the
  // other header sends the operator to the token table for something the token is not.
  const { context } = railway();
  let attempts = 0;
  context.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 403 };
  };

  await assert.rejects(
    () => readCurrentImage(context, 'service-api'),
    /check the service and environment ids/,
  );
  assert.equal(attempts, 1, 'a 403 is not retried under the other header');
});

test('takes the migration command from package.json rather than a copy', async () => {
  // The two used to be byte-identical strings that nothing compared, so changing the data
  // source's path in one left the deploy pointing at a file that no longer exists.
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(migrationCommand, packageJson.scripts['migration:run:prod']);
  assert.doesNotMatch(migrationCommand, /migration:revert/);
});

test('says both were refused when neither works', async () => {
  const { fetch } = tokenFake('neither');
  const { context } = railway();

  await assert.rejects(
    () => readCurrentImage({ ...context, fetch }, 'service-api'),
    /both a project and an account token/,
  );
});
