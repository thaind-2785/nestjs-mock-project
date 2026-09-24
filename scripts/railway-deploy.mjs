/**
 * Points both Railway services at one published digest, and puts back the previous one
 * if the result cannot answer.
 *
 * Written as a module rather than as workflow steps for the reason the rest of this
 * repository states in `.harness/manifest.yaml`: YAML is data. A deploy that decides
 * things - which digest, whether to roll back, when to give up - is code, and code that
 * can only be exercised by merging to `main` is code nobody reviews.
 *
 * Three properties matter, and each is a decision rather than an implementation detail:
 *
 * **The digest, never a tag.** Railway caches a floating tag's digest for about an hour,
 * so redeploying `:main` after a publish re-runs the image it already had. A digest is
 * the bytes; changing it is what makes the platform pull.
 *
 * **Both services or neither.** The API and the worker share a database and a schema. A
 * deploy that moves one and fails on the other leaves two revisions of one application
 * disagreeing about what the tables mean - the exact failure a single image was chosen
 * to make impossible.
 *
 * **The migration is not here.** It runs as Railway's pre-deploy command on the API
 * service, which executes after the build and before the new deployment takes traffic,
 * inside the private network, with the environment already in scope. A failure there
 * stops the deployment and leaves the running revision serving. Running it from the
 * runner instead would mean exposing the database to the internet for the length of
 * every deploy.
 */

import { readFileSync } from 'node:fs';

const API = 'https://backboard.railway.com/graphql/v2';

/**
 * What an image reference must look like before anything is deployed.
 *
 * The module's first stated property was "the digest, never a tag", and until
 * `REVIEW-045` nothing enforced it: `APP_IMAGE` was read straight from the environment,
 * and the workflow policy validated the command that *resolves* a digest rather than the
 * value handed to this script. One word in the export line would have deployed `:main`,
 * which the platform serves from an hour-old cache - the failure ADR-0009 records as
 * observed, dressed as a successful deploy.
 */
export const digestPattern = /@sha256:[0-9a-f]{64}$/;

/**
 * Terminal deployment states, and what each one means for a deploy that is waiting.
 *
 * Waiting on the deployment rather than on a URL is the correction `REVIEW-045` forced:
 * Railway keeps the outgoing revision serving until the incoming one is healthy, so a
 * readiness poll immediately after a deploy is answered `200` by the container being
 * replaced. The gate passed before anything had happened.
 */
const DEPLOYMENT_SUCCEEDED = new Set(['SUCCESS']);
const DEPLOYMENT_FAILED = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

/**
 * What the API service runs between the build and taking traffic.
 *
 * Read from `package.json` rather than copied. The two were byte-identical and nothing
 * compared them, so changing the data source's path in the script would have left the
 * deploy pointing at a file that no longer exists - with every test green, because the
 * contract test checks the *script* while the deploy ran an unchecked literal.
 */
function readMigrationCommand() {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const command = packageJson.scripts?.['migration:run:prod'];
  if (!command || /migration:revert/.test(command)) {
    throw new DeployError(
      'package.json must define migration:run:prod, and it must not revert',
    );
  }
  return command;
}

export const migrationCommand = readMigrationCommand();

export class DeployError extends Error {
  constructor(message, { rolledBack = false } = {}) {
    super(message);
    this.name = 'DeployError';
    this.rolledBack = rolledBack;
  }
}

/**
 * The two ways Railway accepts a token, tried in order of least privilege.
 *
 * A project token is scoped to one environment in one project and authenticates with its
 * own header; an account or workspace token covers everything and uses `Authorization`.
 * Sending the wrong one gets a bare `401` that says nothing about which kind was expected,
 * so this tries the narrow one first and falls back once rather than making the operator
 * know the difference - and the fallback order means a correctly scoped token is the one
 * that works without configuration.
 */
const AUTH_HEADERS = [
  (token) => ({ 'project-access-token': token }),
  (token) => ({ authorization: `Bearer ${token}` }),
];

async function graphql(context, query, variables) {
  // Remembered after the first success. Probing both headers on every call made a deploy
  // twelve HTTP requests where six were guaranteed `401`s, and a fallback asserted once
  // is a fallback asserted at its declaration.
  const order =
    context.authHeader === undefined
      ? (AUTH_HEADERS.keys().toArray?.() ?? [...AUTH_HEADERS.keys()])
      : [context.authHeader];

  let response;
  let index;
  for (index of order) {
    response = await context.fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...AUTH_HEADERS[index](context.token),
      },
      body: JSON.stringify({ query, variables }),
    });
    // Only `401`. A `403` means the token was understood and the call was not permitted -
    // a wrong service or environment id, or a scope that does not cover this project -
    // and retrying it under the other header sends the operator to the token table for a
    // problem that is not the token's kind.
    if (response.status !== 401 || index === order[order.length - 1]) break;
  }
  if (response.ok) context.authHeader = index;

  if (!response.ok) {
    throw new DeployError(
      response.status === 401
        ? 'Railway rejected the token as both a project and an account token'
        : response.status === 403
          ? 'Railway refused the call; check the service and environment ids, and the token scope'
          : `Railway API returned ${response.status}`,
    );
  }
  const body = await response.json();
  if (body.errors?.length) {
    // The message, not the whole payload: a GraphQL error body echoes the variables it
    // was sent, and those carry the service identifiers.
    throw new DeployError(`Railway API: ${body.errors[0].message}`);
  }
  return body.data;
}

/** What a service is running now, so a failed deploy has somewhere to go back to. */
export async function readCurrentImage(context, serviceId) {
  const data = await graphql(
    context,
    `
      query ($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          source {
            image
          }
        }
      }
    `,
    { serviceId, environmentId: context.environmentId },
  );
  return data?.serviceInstance?.source?.image ?? null;
}

/**
 * Writes the image, and for the API the pre-deploy command with it.
 *
 * The command is re-asserted on every deploy rather than set once in the dashboard, so
 * the migration step lives in this repository and cannot be silently removed by somebody
 * clicking through settings.
 */
export async function setImage(context, serviceId, image, { preDeploy } = {}) {
  const input = { source: { image } };
  if (preDeploy) input.preDeployCommand = [preDeploy];

  await graphql(
    context,
    `
      mutation (
        $serviceId: String!
        $environmentId: String!
        $input: ServiceInstanceUpdateInput!
      ) {
        serviceInstanceUpdate(
          serviceId: $serviceId
          environmentId: $environmentId
          input: $input
        )
      }
    `,
    { serviceId, environmentId: context.environmentId, input },
  );
}

/** `serviceInstanceUpdate` only writes configuration; this is what starts a deployment. */
export async function startDeploy(context, serviceId) {
  await graphql(
    context,
    `
      mutation ($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(
          serviceId: $serviceId
          environmentId: $environmentId
        )
      }
    `,
    { serviceId, environmentId: context.environmentId },
  );
}

/**
 * Waits for the deployment this run started to reach a terminal state.
 *
 * `serviceInstanceDeployV2` enqueues; it does not wait. Without this the script moved on
 * while the platform was still pulling, which is how a failed migration - which stops the
 * deployment and leaves the previous revision serving - looked exactly like a success.
 *
 * Newer than `startedAt`, so a previous deployment sitting at `SUCCESS` cannot be mistaken
 * for this one. That mistake is the same shape as the bug being fixed: reading a state
 * that was already true before the action was taken.
 */
export async function waitForDeployment(context, serviceId, startedAt) {
  const deadline = context.now() + context.deploymentBudgetMs;
  let lastSeen = 'no deployment';

  while (context.now() < deadline) {
    const data = await graphql(
      context,
      `
        query ($input: DeploymentListInput!, $first: Int) {
          deployments(input: $input, first: $first) {
            edges {
              node {
                id
                status
                createdAt
              }
            }
          }
        }
      `,
      {
        first: 5,
        input: {
          projectId: context.projectId,
          serviceId,
          environmentId: context.environmentId,
        },
      },
    );

    const nodes = (data?.deployments?.edges ?? []).map((edge) => edge.node);
    const mine = nodes.find(
      (node) => Date.parse(node.createdAt) >= startedAt - 1000,
    );
    if (mine) {
      lastSeen = mine.status;
      if (DEPLOYMENT_SUCCEEDED.has(mine.status)) return mine.id;
      if (DEPLOYMENT_FAILED.has(mine.status)) {
        throw new DeployError(`deployment ${mine.status} for ${serviceId}`);
      }
    }
    await context.sleep(context.pollIntervalMs);
  }
  throw new DeployError(
    `deployment did not finish for ${serviceId} (last: ${lastSeen})`,
  );
}

/**
 * Waits until the revision answering is the one being deployed.
 *
 * The second half of the same correction. A deployment reaching `SUCCESS` says the
 * platform is satisfied; this says the public address is actually served by the new build.
 * `/health/live` rather than `/health/ready`, because the question here is identity, not
 * dependency health - readiness is asked next, and asking both at once would confuse "the
 * old revision is still answering" with "the new one cannot reach its database".
 */
export async function waitForRevision(context, expected) {
  const deadline = context.now() + context.readinessBudgetMs;
  let lastSeen = 'no response';

  while (context.now() < deadline) {
    try {
      const response = await context.fetch(context.livenessUrl, {
        method: 'GET',
      });
      if (response.status === 200) {
        const body = await response.json();
        if (body?.revision === expected) return;
        lastSeen = `revision ${body?.revision ?? 'absent'}`;
      } else {
        lastSeen = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastSeen = error instanceof Error ? error.name : 'request failed';
    }
    await context.sleep(context.pollIntervalMs);
  }
  throw new DeployError(
    `the deployed revision never became ${expected} (last: ${lastSeen})`,
  );
}

/**
 * Polls readiness until it answers `200`, or the budget runs out.
 *
 * `/health/ready` and not `/health/live`: liveness says the process exists, which a
 * container that cannot reach its database also satisfies. Readiness is the endpoint that
 * checks MySQL, Redis and object storage, so it is the one that can tell a deploy from a
 * deploy that only looks finished.
 *
 * A non-200 is not a failure while the budget lasts. The platform replaces containers
 * asynchronously, so the first requests after a deploy legitimately reach the old one,
 * nothing, or a starting one.
 */
export async function waitForReady(context, { budgetMs, intervalMs }) {
  const deadline = context.now() + budgetMs;
  let lastSeen = 'no response';

  while (context.now() < deadline) {
    try {
      const response = await context.fetch(context.readinessUrl, {
        method: 'GET',
      });
      if (response.status === 200) return;
      lastSeen = `HTTP ${response.status}`;
    } catch (error) {
      lastSeen = error instanceof Error ? error.name : 'request failed';
    }
    await context.sleep(intervalMs);
  }
  throw new DeployError(`readiness never returned 200 (last: ${lastSeen})`);
}

export async function deploy(context) {
  const { api, worker } = context.services;
  const log = context.log ?? (() => {});

  if (!digestPattern.test(context.image)) {
    // Before anything is written. A tag deploys the platform's hour-old cache of whatever
    // it last resolved, and reports success for it.
    throw new DeployError(
      `APP_IMAGE must name a digest, not a tag: ${context.image}`,
    );
  }

  // Read before writing, so the way back exists before the way forward is taken.
  const previous = {
    api: await readCurrentImage(context, api),
    worker: await readCurrentImage(context, worker),
  };
  log({ event: 'deploy_previous_resolved', ...previous });

  if (!previous.api || !previous.worker) {
    // Nothing to roll back to. A first deploy is a manual step, and finding that out
    // here is better than finding it out halfway through a failed one.
    throw new DeployError(
      'a service has no current image; deploy it by hand once before automating it',
    );
  }

  // What has actually been written, so a rollback restores exactly that and nothing else.
  // Restoring a service that was never moved would redeploy a healthy worker - killing
  // in-flight export and mail work - for a failure it had no part in.
  const moved = [];

  try {
    // The API first, because it carries the migration. If the schema change fails, the
    // pre-deploy command stops the deployment and the worker is never moved.
    const apiStartedAt = context.now();
    await setImage(context, api, context.image, {
      preDeploy: migrationCommand,
    });
    moved.push(api);
    await startDeploy(context, api);
    log({ event: 'deploy_started', service: 'api', image: context.image });

    await waitForDeployment(context, api, apiStartedAt);
    await waitForRevision(context, context.revision);
    await waitForReady(context, {
      budgetMs: context.readinessBudgetMs,
      intervalMs: context.pollIntervalMs,
    });
    log({ event: 'deploy_ready', service: 'api', revision: context.revision });

    const workerStartedAt = context.now();
    await setImage(context, worker, context.image);
    moved.push(worker);
    await startDeploy(context, worker);
    log({ event: 'deploy_started', service: 'worker', image: context.image });

    // The worker has no HTTP surface, so the platform's own view of the deployment is the
    // only thing that can say it started. Without this the half of "both services or
    // neither" that carries mail, export and retention was never checked at all.
    await waitForDeployment(context, worker, workerStartedAt);
    log({ event: 'deploy_ready', service: 'worker' });
  } catch (error) {
    log({
      event: 'deploy_failed',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    const rolledBack = await rollback(context, previous, moved, log);
    throw new DeployError(
      error instanceof Error ? error.message : 'deploy failed',
      { rolledBack },
    );
  }
}

/**
 * Restores what was written, and reports whether the result answers.
 *
 * The return value is the point. It used to be an unconditional `rolledBack: true` on the
 * error, which meant the one machine-readable field an operator keys on said "restored"
 * for the state where neither the deploy nor the restore had worked - and deleting the
 * field left every test green, because nothing read it.
 *
 * The migration is deliberately not reverted. Migrations here are expand-only, so the
 * previous code runs against the migrated schema; reverting one automatically is how a
 * partial migration becomes data loss, and that is a decision for a person.
 */
async function rollback(context, previous, moved, log) {
  if (moved.length === 0) {
    log({ event: 'deploy_rollback_unnecessary' });
    return true;
  }

  try {
    for (const serviceId of moved) {
      const isApi = serviceId === context.services.api;
      const image = isApi ? previous.api : previous.worker;
      const startedAt = context.now();
      await setImage(
        context,
        serviceId,
        image,
        isApi ? { preDeploy: migrationCommand } : {},
      );
      await startDeploy(context, serviceId);
      await waitForDeployment(context, serviceId, startedAt);
    }
    log({ event: 'deploy_rolled_back', services: moved.length, ...previous });

    await waitForReady(context, {
      budgetMs: context.readinessBudgetMs,
      intervalMs: context.pollIntervalMs,
    });
    log({ event: 'deploy_rollback_ready' });
    return true;
  } catch (error) {
    // The deploy failed and so did the way back. Said plainly, and reported as `false`,
    // because this is the state that needs a person now rather than at the next working
    // hour - and because an alert keying on the flag would otherwise stand down.
    log({
      event: 'deploy_rollback_failed',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new DeployError(`${name} is required`);
  return value;
}

export function contextFromEnvironment() {
  return {
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (record) => console.log(JSON.stringify(record)),
    token: requireEnv('RAILWAY_TOKEN'),
    environmentId: requireEnv('RAILWAY_ENVIRONMENT_ID'),
    projectId: requireEnv('RAILWAY_PROJECT_ID'),
    revision: requireEnv('GITHUB_SHA'),
    services: {
      api: requireEnv('RAILWAY_API_SERVICE_ID'),
      worker: requireEnv('RAILWAY_WORKER_SERVICE_ID'),
    },
    image: requireEnv('APP_IMAGE'),
    readinessUrl: `${requireEnv('PUBLIC_BASE_URL')}/api/v1/health/ready`,
    livenessUrl: `${requireEnv('PUBLIC_BASE_URL')}/api/v1/health/live`,
    // Generous, and deliberately so: the platform builds nothing here but it does pull an
    // image, run the migration, start the process and wait for its own health check.
    readinessBudgetMs: 420_000,
    // The platform's own work: pull the image, run the migration, start the process and
    // satisfy its own health check. Generous, because exhausting it rolls back a deploy
    // that may simply have been slow.
    deploymentBudgetMs: 600_000,
    pollIntervalMs: 10_000,
  };
}

async function runCli() {
  try {
    await deploy(contextFromEnvironment());
    console.log(JSON.stringify({ event: 'deploy_completed' }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'deploy_aborted',
        reason: error instanceof Error ? error.message : 'unknown',
        rolledBack: error instanceof DeployError ? error.rolledBack : false,
      }),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  process.argv[1].endsWith('railway-deploy.mjs') &&
  !process.env.RAILWAY_DEPLOY_IMPORT_ONLY
) {
  await runCli();
}
