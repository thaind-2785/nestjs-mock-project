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
      resolve(
        loaded.rootDirectory,
        loaded.config.runtime_contract.ci_workflow,
      ),
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
  assert.ok(
    validateConfig(wrongPairing).some((error) =>
      error.includes('integrity_policy'),
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
