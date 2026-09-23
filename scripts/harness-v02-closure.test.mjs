import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadHarness, validateHarness } from './harness-check.mjs';
import { validateCiWorkflowEnvelope } from './harness-ci-policy.mjs';

const loaded = loadHarness();

function validateConfig(config) {
  return validateHarness(
    config,
    loaded.packageJson,
    loaded.rootDirectory,
    loaded.schema,
  );
}

function loadWorkflow() {
  return parse(
    readFileSync(
      resolve(loaded.rootDirectory, loaded.config.runtime_contract.ci_workflow),
      'utf8',
    ),
  );
}

test('restore_locked_dependencies requires committed dependency integrity', () => {
  const missingPolicy = structuredClone(loaded.config);
  delete missingPolicy.entry_commands.bootstrap.integrity_policy;
  assert.ok(
    validateConfig(missingPolicy).some((error) =>
      error.includes('integrity_policy'),
    ),
  );

  const wrongPairing = structuredClone(loaded.config);
  wrongPairing.entry_commands.build.integrity_policy =
    'committed_dependency_graph';
  const wrongPairingErrors = validateConfig(wrongPairing);
  assert.ok(wrongPairingErrors.length > 0);
  assert.ok(
    wrongPairingErrors.some(
      (error) =>
        error.includes('entry_commands.build') ||
        error.includes('must NOT be valid'),
    ),
  );
});

test('reviewed CI envelope rejects workflow-level environment injection', () => {
  const workflow = loadWorkflow();
  workflow.env = {
    NODE_OPTIONS: '--require ./attacker-controlled.js',
  };
  assert.ok(
    validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
      error.includes('reviewed top-level keys'),
    ),
  );
});

test('reviewed CI envelope rejects workflow defaults', () => {
  const workflow = loadWorkflow();
  workflow.defaults = { run: { shell: 'bash -e {0}' } };
  assert.ok(
    validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
      error.includes('reviewed top-level keys'),
    ),
  );
});

test('reviewed CI envelope rejects job-level environment injection', () => {
  const workflow = loadWorkflow();
  workflow.jobs.verify.env = {
    NODE_OPTIONS: '--require ./attacker-controlled.js',
  };
  assert.ok(
    validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
      error.includes('reviewed job keys'),
    ),
  );
});

test('the published image is scanned before it leaves the runner', () => {
  const workflow = loadWorkflow();
  const steps = workflow.jobs.publish.steps;
  const scan = steps.findIndex((step) => step.name === 'Scan the image');
  const push = steps.findIndex((step) =>
    String(step.run ?? '').includes('--push'),
  );

  // Swapping the two steps is a one-line edit that no build, test or deploy notices, and
  // it cannot be undone afterwards: whoever pulled the image already has it, and deleting
  // the tag leaves the layers in their cache.
  [steps[scan], steps[push]] = [steps[push], steps[scan]];

  assert.ok(
    validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
      error.includes('must scan the image before pushing it'),
    ),
  );
});

test('publishing waits for the gate, and only on main', () => {
  for (const [mutate, expected] of [
    [(workflow) => delete workflow.jobs.publish.needs, 'reviewed job keys'],
    [
      (workflow) => {
        workflow.jobs.publish.needs = 'lint';
      },
      'must depend on the verify job',
    ],
    [
      (workflow) => {
        workflow.jobs.publish.if = "github.event_name == 'push'";
      },
      'must run only for main',
    ],
  ]) {
    const workflow = loadWorkflow();
    mutate(workflow);
    assert.ok(
      validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
        error.includes(expected),
      ),
      `expected an error containing ${expected}`,
    );
  }
});

test('the publishing job holds the registry credential and nothing more', () => {
  for (const permissions of [
    { contents: 'write', packages: 'write' },
    { contents: 'read', packages: 'write', 'id-token': 'write' },
    { packages: 'write' },
  ]) {
    const workflow = loadWorkflow();
    workflow.jobs.publish.permissions = permissions;
    assert.ok(
      validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
        error.includes('contents: read and packages: write'),
      ),
    );
  }
});

test('what is published is identified by commit, and carries no secret', () => {
  for (const [mutate, expected] of [
    [
      (steps) => {
        // The tag that cannot answer "what is deployed".
        steps.find((step) => String(step.run ?? '').includes('--push')).run =
          'docker buildx build --platform linux/amd64,linux/arm64 --tag ghcr.io/owner/repo:latest --push .';
      },
      'must publish a commit-SHA tag',
    ],
    [
      (steps) => {
        const build = steps.find((step) =>
          String(step.run ?? '').includes('--build-arg GIT_SHA'),
        );
        build.run = build.run.replace(
          '--build-arg GIT_SHA',
          '--build-arg NPM_TOKEN="${NPM_TOKEN}" --build-arg GIT_SHA',
        );
      },
      'no build argument other than GIT_SHA',
    ],
    [
      (steps) => {
        steps.find((step) => step.name === 'Scan the image').run = String(
          steps.find((step) => step.name === 'Scan the image').run,
        ).replace('--exit-code 1', '--exit-code 0');
      },
      'must fail the job on a finding',
    ],
  ]) {
    const workflow = loadWorkflow();
    mutate(workflow.jobs.publish.steps);
    assert.ok(
      validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
        error.includes(expected),
      ),
      `expected an error containing ${expected}`,
    );
  }
});

test('publishes for the architecture the host actually runs', () => {
  const workflow = loadWorkflow();
  const push = workflow.jobs.publish.steps.find((step) =>
    String(step.run ?? '').includes('--push'),
  );

  // The failure this prevents is the latest one possible: an amd64-only image passes the
  // gate, passes the scan, publishes, pulls onto the arm64 host and dies at `compose up`
  // with `exec format error` - after the migration has already run.
  push.run = push.run.replace('linux/amd64,linux/arm64', 'linux/amd64');

  assert.ok(
    validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
      error.includes('both linux/amd64 and linux/arm64'),
    ),
  );
});

test('reviewed CI envelope rejects job execution-surface expansion', () => {
  for (const mutate of [
    (workflow) => {
      workflow.jobs.verify.defaults = { run: { shell: 'bash -e {0}' } };
    },
    (workflow) => {
      workflow.jobs.verify.container = 'node:22';
    },
    (workflow) => {
      workflow.jobs.verify.services = { db: { image: 'postgres:17' } };
    },
  ]) {
    const workflow = loadWorkflow();
    mutate(workflow);
    assert.ok(
      validateCiWorkflowEnvelope(workflow, loaded.config).some((error) =>
        error.includes('reviewed job keys'),
      ),
    );
  }
});
