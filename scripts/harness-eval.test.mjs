import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHarness } from './harness-check.mjs';
import { loadEvaluationSuite, runEvaluationSuite } from './harness-eval.mjs';

const loaded = loadHarness();
const suite = loadEvaluationSuite(
  loaded.rootDirectory,
  loaded.config.evaluation_strategy.fixture_path,
);

test('passes the repository behavioral Harness fixtures', () => {
  const results = runEvaluationSuite(loaded.config, suite);
  assert.equal(results.length, 10);
  assert.deepEqual(
    results.filter((result) => !result.passed),
    [],
  );
});

test('detects a canonical route mutation', () => {
  const config = structuredClone(loaded.config);
  config.context_strategy.routes.find(
    (route) => route.id === 'api_product',
  ).source_ids = ['normalized_scope'];

  const failures = runEvaluationSuite(config, suite).filter(
    (result) => !result.passed,
  );
  assert.ok(failures.some((failure) => failure.id === 'api_product_context'));
});

test('detects a permission effect mutation', () => {
  const config = structuredClone(loaded.config);
  config.permission_model.actions.run_local_checks.effect = 'deny';

  const failures = runEvaluationSuite(config, suite).filter(
    (result) => !result.passed,
  );
  assert.ok(failures.some((failure) => failure.id === 'allowed_local_check'));
});

test('detects fixture expectation mutation instead of self-approving it', () => {
  const mutatedSuite = structuredClone(suite);
  mutatedSuite.fixtures.find(
    (fixture) => fixture.id === 'handoff_requires_full_gate',
  ).expected.command_ref = 'build';

  const failures = runEvaluationSuite(loaded.config, mutatedSuite).filter(
    (result) => !result.passed,
  );
  assert.deepEqual(
    failures.map((failure) => failure.id),
    ['handoff_requires_full_gate'],
  );
});
