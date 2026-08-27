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
    concurrency?.group !== 'ci-${{ github.workflow }}-${{ github.ref }}' ||
    concurrency?.['cancel-in-progress'] !== true
  ) {
    addError(
      `${rootPath}.concurrency`,
      'must match the reviewed concurrency contract exactly',
    );
  }

  if (!hasExactKeys(workflow?.jobs, ['verify'])) {
    addError(`${rootPath}.jobs`, 'must contain exactly the verify job');
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
