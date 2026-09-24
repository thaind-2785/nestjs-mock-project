import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadHarness } from './harness-check.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '..');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function validateCiWorkflowEnvelope(workflow, config) {
  const errors = [];
  const addError = (path, message) => errors.push(`${path}: ${message}`);
  const rootPath = 'runtime_contract.ci_workflow';

  if (
    !hasExactKeys(workflow, [
      'name',
      'on',
      'permissions',
      'concurrency',
      'jobs',
    ])
  ) {
    addError(
      rootPath,
      'must contain exactly the reviewed top-level keys and no workflow-level env/defaults injection',
    );
  }
  if (workflow?.name !== 'CI') {
    addError(`${rootPath}.name`, 'must equal CI');
  }

  const triggers = workflow?.on;
  if (!hasExactKeys(triggers, ['pull_request', 'push'])) {
    addError(
      `${rootPath}.on`,
      'must contain exactly pull_request and push triggers',
    );
  }
  if (
    triggers?.pull_request !== null &&
    !(
      isRecord(triggers?.pull_request) &&
      Object.keys(triggers.pull_request).length === 0
    )
  ) {
    addError(
      `${rootPath}.on.pull_request`,
      'must be unfiltered so every pull request runs the gate',
    );
  }
  if (
    !hasExactKeys(triggers?.push, ['branches']) ||
    !Array.isArray(triggers?.push?.branches) ||
    triggers.push.branches.length !== 1 ||
    triggers.push.branches[0] !== 'main'
  ) {
    addError(`${rootPath}.on.push`, 'must contain only branches: [main]');
  }

  const concurrency = workflow?.concurrency;
  if (
    !hasExactKeys(concurrency, ['group', 'cancel-in-progress']) ||
    concurrency?.group !== 'ci-${{ github.workflow }}-${{ github.ref }}'
  ) {
    addError(
      `${rootPath}.concurrency`,
      'must match the reviewed concurrency contract exactly',
    );
  }
  // The rule rather than the string: a run on `main` may not be cancelled, because the
  // deploy's two `setImage` calls are not atomic and a kill between them leaves the API
  // and the worker on different digests with no rollback and no failure event.
  if (
    concurrency?.['cancel-in-progress'] !== false &&
    !String(concurrency?.['cancel-in-progress'] ?? '').includes(
      "github.ref != 'refs/heads/main'",
    )
  ) {
    addError(
      `${rootPath}.concurrency.cancel-in-progress`,
      'must not cancel a run on main',
    );
  }

  if (!hasExactKeys(workflow?.jobs, ['verify', 'publish', 'deploy'])) {
    addError(
      `${rootPath}.jobs`,
      'must contain exactly the verify, publish and deploy jobs',
    );
  }

  const job = workflow?.jobs?.verify;
  if (!hasExactKeys(job, ['name', 'runs-on', 'timeout-minutes', 'steps'])) {
    addError(
      `${rootPath}.jobs.verify`,
      'must contain exactly the reviewed job keys; job-level env/defaults/container/services are forbidden',
    );
  }
  if (job?.['runs-on'] !== 'ubuntu-latest') {
    addError(`${rootPath}.jobs.verify.runs-on`, 'must equal ubuntu-latest');
  }
  if (job?.name !== config.pr_lifecycle.merge_enforcement.required_check) {
    addError(
      `${rootPath}.jobs.verify.name`,
      'must match the required GitHub check name',
    );
  }

  errors.push(...validatePublishJob(workflow?.jobs?.publish, rootPath));
  errors.push(...validateDeployJob(workflow?.jobs?.deploy, rootPath));

  return errors;
}

/**
 * The deploying job, which is the only one in this repository that can change what the
 * public is served.
 *
 * Its rules are about *where the decisions live* rather than about what they are. The
 * deploy itself - which digest, whether to roll back, when to give up - is in
 * `scripts/railway-deploy.mjs`, where it has unit tests. What this checks is that the
 * workflow keeps handing the work to that file instead of growing its own copy in YAML,
 * which nothing would test and nobody would review.
 */
function validateDeployJob(job, rootPath) {
  const errors = [];
  const addError = (path, message) => errors.push(`${path}: ${message}`);
  const jobPath = `${rootPath}.jobs.deploy`;

  if (
    !hasExactKeys(job, [
      'name',
      'needs',
      'if',
      'runs-on',
      'timeout-minutes',
      'environment',
      'steps',
    ])
  ) {
    addError(
      jobPath,
      'must contain exactly the reviewed job keys; env/defaults/container/services are forbidden',
    );
    return errors;
  }

  // Nothing is deployed that was not published, and nothing is deployed from a branch.
  if (job['needs'] !== 'publish') {
    addError(`${jobPath}.needs`, 'must depend on the publish job');
  }
  if (job['if'] !== "github.ref == 'refs/heads/main'") {
    addError(`${jobPath}.if`, 'must run only for main');
  }
  if (job['runs-on'] !== 'ubuntu-latest') {
    addError(`${jobPath}.runs-on`, 'must equal ubuntu-latest');
  }

  // A named environment, so the platform credentials are scoped to this job rather than
  // readable by every workflow in the repository.
  if (job.environment !== 'production') {
    addError(`${jobPath}.environment`, 'must name the production environment');
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const commands = steps.map((step) => String(step?.run ?? ''));

  // The decisions stay in the tested module. A workflow that starts calling the platform
  // API directly is a workflow that has grown an untested deploy.
  if (!commands.some((c) => c.includes('scripts/railway-deploy.mjs'))) {
    addError(
      `${jobPath}.steps`,
      'must deploy through scripts/railway-deploy.mjs',
    );
  }
  for (const [index, command] of commands.entries()) {
    if (
      command.includes('backboard.railway.com') &&
      !command.includes('railway-deploy.mjs')
    ) {
      addError(
        `${jobPath}.steps[${index}]`,
        'must not call the platform API from the workflow; that logic belongs in the tested module',
      );
    }
  }

  // Every step is either the reviewed checkout, the digest lookup, or the module. The
  // previous rule only forbade naming the platform's host, which left a step free to
  // `curl` the token somewhere or run a migration from the runner - the one thing the
  // module's own docstring says it exists to avoid.
  for (const [index, step] of steps.entries()) {
    const command = String(step?.run ?? '');
    const uses = String(step?.uses ?? '');
    const reviewed =
      uses.startsWith('actions/checkout@') ||
      command.includes('scripts/railway-deploy.mjs') ||
      command.includes('docker-content-digest');
    if (!reviewed) {
      addError(
        `${jobPath}.steps[${index}]`,
        'is not a reviewed deploy step; the deploy runs through the tested module',
      );
    }
    if (/migration:run|typeorm/.test(command)) {
      addError(
        `${jobPath}.steps[${index}]`,
        'must not run migrations from the runner; that is the platform pre-deploy command',
      );
    }
  }

  // Resolved from the registry rather than carried between jobs, and a digest either way:
  // a tag is a pointer, and the platform caches what a floating tag resolved to.
  const resolve = commands.find((c) => c.includes('docker-content-digest'));
  if (!resolve) {
    addError(
      `${jobPath}.steps`,
      'must resolve the published digest from the registry',
    );
  } else if (!resolve.includes('${GITHUB_SHA}')) {
    addError(
      `${jobPath}.steps`,
      'must resolve the digest for this commit, not for a moving tag',
    );
  } else if (!/APP_IMAGE=\$\{IMAGE\}@\$\{DIGEST\}/.test(resolve)) {
    // The value handed to the script, not only the command that looked a digest up. One
    // word here - `:main` instead of `@${DIGEST}` - deploys the platform's hour-old cache
    // and reports success, and the policy used to validate only the lookup.
    addError(
      `${jobPath}.steps`,
      'must export APP_IMAGE as the resolved digest',
    );
  }

  return errors;
}

/**
 * The publishing job, held to the same envelope as the gate and to three rules of its
 * own.
 *
 * It is in this workflow rather than a second one for the reason the gate is reviewed at
 * all: a workflow nobody validates is a workflow anybody can add a step to. One file, one
 * dependency edge, one policy.
 */
function validatePublishJob(job, rootPath) {
  const errors = [];
  const addError = (path, message) => errors.push(`${path}: ${message}`);
  const jobPath = `${rootPath}.jobs.publish`;

  if (
    !hasExactKeys(job, [
      'name',
      'needs',
      'if',
      'runs-on',
      'timeout-minutes',
      'permissions',
      'steps',
    ])
  ) {
    addError(
      jobPath,
      'must contain exactly the reviewed job keys; env/defaults/container/services are forbidden',
    );
    return errors;
  }

  // Nothing is published from a tree that did not pass the gate, and nothing is published
  // from a branch. Both halves matter: `needs` alone would still publish every pull
  // request, and the branch condition alone would publish a red `main`.
  if (job['needs'] !== 'verify') {
    addError(`${jobPath}.needs`, 'must depend on the verify job');
  }
  if (job['if'] !== "github.ref == 'refs/heads/main'") {
    addError(`${jobPath}.if`, 'must run only for main');
  }
  if (job['runs-on'] !== 'ubuntu-latest') {
    addError(`${jobPath}.runs-on`, 'must equal ubuntu-latest');
  }

  // Write access to packages and nothing else. A job holding the registry credential is
  // the one job in this repository whose token is worth stealing.
  if (
    !hasExactKeys(job.permissions, ['contents', 'packages']) ||
    job.permissions.contents !== 'read' ||
    job.permissions.packages !== 'write'
  ) {
    addError(
      `${jobPath}.permissions`,
      'must grant exactly contents: read and packages: write',
    );
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const indexOfStep = (needle) =>
    steps.findIndex((step) => String(step?.run ?? '').includes(needle));
  const scanIndex = indexOfStep('aquasec/trivy@sha256:');
  const pushIndex = indexOfStep('--push');

  if (scanIndex === -1) {
    addError(
      `${jobPath}.steps`,
      'must scan the image with a digest-pinned scanner',
    );
  }
  if (pushIndex === -1) {
    addError(`${jobPath}.steps`, 'must push the image');
  }

  // The host is arm64 and this runner is amd64. An image built for one architecture runs
  // everywhere except the machine it is for, and announces that as `exec format error` at
  // `compose up` - after the migration has already run.
  if (pushIndex !== -1) {
    const platforms = String(steps[pushIndex].run);
    if (
      !platforms.includes('linux/amd64') ||
      !platforms.includes('linux/arm64')
    ) {
      addError(
        `${jobPath}.steps`,
        'must publish for both linux/amd64 and linux/arm64',
      );
    }
  }
  // The rule this job exists to keep. A published image cannot be recalled, so a scan
  // after the push reports what has already been given away.
  if (scanIndex !== -1 && pushIndex !== -1 && scanIndex > pushIndex) {
    addError(`${jobPath}.steps`, 'must scan the image before pushing it');
  }

  const scanCommand = scanIndex === -1 ? '' : String(steps[scanIndex].run);
  if (!scanCommand.includes('--exit-code 1')) {
    addError(`${jobPath}.steps`, 'the scan must fail the job on a finding');
  }
  if (!scanCommand.includes('--severity HIGH,CRITICAL')) {
    addError(`${jobPath}.steps`, 'the scan must cover HIGH and CRITICAL');
  }

  // Tagged by commit, never by a moving pointer alone: `latest` cannot answer "what is
  // deployed", and a deploy that resolves it gets whatever was pushed most recently.
  const pushCommand = pushIndex === -1 ? '' : String(steps[pushIndex].run);
  if (!pushCommand.includes('${GITHUB_SHA}')) {
    addError(`${jobPath}.steps`, 'must publish a commit-SHA tag');
  }
  if (/:latest\b/.test(pushCommand)) {
    addError(`${jobPath}.steps`, 'must not publish a latest tag');
  }

  // The image needs no secret to build, and a build argument is readable by anybody who
  // pulls the result.
  for (const step of steps) {
    const command = String(step?.run ?? '');
    if (/--build-arg\s+(?!GIT_SHA)/.test(command)) {
      addError(
        `${jobPath}.steps`,
        'must pass no build argument other than GIT_SHA',
      );
    }
  }

  return errors;
}

export function runCiPolicyCheck(rootDirectory = defaultRoot) {
  const loaded = loadHarness(rootDirectory);
  const workflowPath = resolve(
    rootDirectory,
    loaded.config.runtime_contract.ci_workflow,
  );
  const workflow = parse(readFileSync(workflowPath, 'utf8'));
  return validateCiWorkflowEnvelope(workflow, loaded.config);
}

function runCli() {
  try {
    const errors = runCiPolicyCheck();
    if (errors.length > 0) {
      console.error('Harness CI policy validation failed:');
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log('Harness CI workflow envelope valid.');
  } catch (error) {
    console.error(`Harness CI policy validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
