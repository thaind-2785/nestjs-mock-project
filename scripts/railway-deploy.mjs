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

const API = 'https://backboard.railway.com/graphql/v2';

/** What the API service runs between the build and taking traffic. */
export const migrationCommand =
  'node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js';

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
  let response;
  for (const [index, header] of AUTH_HEADERS.entries()) {
    response = await context.fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...header(context.token),
      },
      body: JSON.stringify({ query, variables }),
    });
    const rejected = response.status === 401 || response.status === 403;
    if (!rejected || index === AUTH_HEADERS.length - 1) break;
  }

  if (!response.ok) {
    throw new DeployError(
      response.status === 401 || response.status === 403
        ? 'Railway rejected the token as both a project and an account token'
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

  try {
    // The API first, because it carries the migration. If the schema change fails, the
    // pre-deploy command stops the deployment and the worker is never moved.
    await setImage(context, api, context.image, {
      preDeploy: migrationCommand,
    });
    await startDeploy(context, api);
    log({ event: 'deploy_started', service: 'api', image: context.image });

    await waitForReady(context, {
      budgetMs: context.readinessBudgetMs,
      intervalMs: context.pollIntervalMs,
    });
    log({ event: 'deploy_ready', service: 'api' });

    await setImage(context, worker, context.image);
    await startDeploy(context, worker);
    log({ event: 'deploy_started', service: 'worker', image: context.image });
  } catch (error) {
    log({
      event: 'deploy_failed',
      reason: error instanceof Error ? error.message : 'unknown',
    });
    await rollback(context, previous, log);
    throw new DeployError(
      error instanceof Error ? error.message : 'deploy failed',
      { rolledBack: true },
    );
  }
}

/**
 * Puts both services back, and checks that the result answers.
 *
 * The migration is deliberately not reverted. Migrations in this project are expand-only,
 * so the previous code runs against the migrated schema; reverting one automatically is
 * how a partial migration becomes data loss, and that is a decision for a person.
 */
async function rollback(context, previous, log) {
  try {
    await setImage(context, context.services.api, previous.api, {
      preDeploy: migrationCommand,
    });
    await startDeploy(context, context.services.api);
    await setImage(context, context.services.worker, previous.worker);
    await startDeploy(context, context.services.worker);
    log({ event: 'deploy_rolled_back', ...previous });

    await waitForReady(context, {
      budgetMs: context.readinessBudgetMs,
      intervalMs: context.pollIntervalMs,
    });
    log({ event: 'deploy_rollback_ready' });
  } catch (error) {
    // The deploy failed and so did the way back. Said plainly, because this is the state
    // that needs a person now rather than at the next working hour.
    log({
      event: 'deploy_rollback_failed',
      reason: error instanceof Error ? error.message : 'unknown',
    });
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
    services: {
      api: requireEnv('RAILWAY_API_SERVICE_ID'),
      worker: requireEnv('RAILWAY_WORKER_SERVICE_ID'),
    },
    image: requireEnv('APP_IMAGE'),
    readinessUrl: `${requireEnv('PUBLIC_BASE_URL')}/api/v1/health/ready`,
    // Generous, and deliberately so: the platform builds nothing here but it does pull an
    // image, run the migration, start the process and wait for its own health check.
    readinessBudgetMs: 420_000,
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
