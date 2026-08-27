import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadHarness } from './harness-check.mjs';
import {
  evaluateCommandPolicy,
  HarnessPolicyError,
  resolveCommand,
  selectContext,
} from './harness-runtime.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '..');

export function loadEvaluationSuite(
  rootDirectory = defaultRoot,
  fixturePath = '.harness/evaluations.yaml',
) {
  const suite = parse(
    readFileSync(resolve(rootDirectory, fixturePath), 'utf8'),
  );
  if (suite?.schema_version !== '0.2' || !Array.isArray(suite?.fixtures)) {
    throw new HarnessPolicyError(
      'invalid_evaluation_suite',
      'Harness evaluation suite must use schema 0.2 and contain fixtures',
    );
  }
  const ids = suite.fixtures.map((fixture) => fixture?.id);
  if (
    ids.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(ids).size !== ids.length
  ) {
    throw new HarnessPolicyError(
      'invalid_evaluation_suite',
      'Harness evaluation fixture ids must be present and unique',
    );
  }
  return suite;
}

function evaluateContextFixture(config, fixture) {
  const selected = selectContext({ config, taskClasses: fixture.task_classes });
  const level = config.autonomy_levels.levels.find(
    (item) => item.id === fixture.autonomy_level,
  );
  if (!level || level.status !== 'active') {
    throw new HarnessPolicyError(
      'invalid_evaluation_fixture',
      `Context fixture "${fixture.id}" references an inactive autonomy level`,
    );
  }
  return {
    route_ids: [...selected.routeIds],
    source_ids: [...selected.sourceIds],
    autonomy_permissions: [...level.permissions],
  };
}

function evaluateCommandFixture(config, fixture) {
  try {
    const resolved = resolveCommand({
      config,
      commandRef: fixture.command_ref,
      environmentId: fixture.environment_id,
    });
    const requested = fixture.permission_override
      ? Object.freeze({
          ...resolved,
          permissionId: fixture.permission_override,
        })
      : resolved;
    const policy = evaluateCommandPolicy({
      config,
      resolvedCommand: requested,
      autonomyLevelId: fixture.autonomy_level,
    });
    return {
      command_ref: requested.commandRef,
      tool_id: requested.toolId,
      permission_id: requested.permissionId,
      decision: policy.decision,
      reason_code: policy.reasonCode,
    };
  } catch (error) {
    if (!(error instanceof HarnessPolicyError)) throw error;
    return { decision: 'reject', reason_code: error.code };
  }
}

function evaluateCapabilityFixture(config, fixture) {
  const tool = config.tool_registry.find((item) => item.id === fixture.tool_id);
  if (!tool)
    return { availability: 'unavailable', reason_code: 'unknown_tool' };
  if (tool.status !== 'active') {
    return { availability: 'unavailable', reason_code: 'planned_tool' };
  }
  return { availability: 'active', reason_code: 'active_tool' };
}

function evaluateHandoffFixture(config, fixture) {
  const hook = config.hook_lifecycle.hooks.find(
    (item) => item.id === fixture.hook_id,
  );
  if (!hook) return { status: 'missing' };
  return {
    command_ref: hook.command_ref,
    status: hook.status,
    failure_policy: hook.failure_policy,
    required_by_pr: config.pr_lifecycle.required_commands.includes(
      hook.command_ref,
    ),
  };
}

export function evaluateFixture(config, fixture) {
  switch (fixture.type) {
    case 'context_route':
      return evaluateContextFixture(config, fixture);
    case 'command_policy':
      return evaluateCommandFixture(config, fixture);
    case 'capability_status':
      return evaluateCapabilityFixture(config, fixture);
    case 'handoff_gate':
      return evaluateHandoffFixture(config, fixture);
    default:
      throw new HarnessPolicyError(
        'invalid_evaluation_fixture',
        `Unknown evaluation fixture type: ${String(fixture.type)}`,
      );
  }
}

export function runEvaluationSuite(config, suite) {
  return suite.fixtures.map((fixture) => {
    const actual = evaluateFixture(config, fixture);
    try {
      assert.deepEqual(actual, fixture.expected);
      return Object.freeze({ id: fixture.id, passed: true, actual });
    } catch {
      return Object.freeze({
        id: fixture.id,
        passed: false,
        expected: fixture.expected,
        actual,
      });
    }
  });
}

function runCli() {
  try {
    const { config, rootDirectory } = loadHarness();
    const suite = loadEvaluationSuite(
      rootDirectory,
      config.evaluation_strategy.fixture_path,
    );
    const results = runEvaluationSuite(config, suite);
    const failures = results.filter((result) => !result.passed);
    if (failures.length > 0) {
      console.error('Harness behavioral evaluation failed:');
      for (const failure of failures) {
        console.error(
          `- ${failure.id}: expected ${JSON.stringify(failure.expected)}, received ${JSON.stringify(failure.actual)}`,
        );
      }
      process.exitCode = 1;
      return;
    }
    console.log(
      `Harness behavioral evaluation passed: ${results.length} fixtures.`,
    );
  } catch (error) {
    console.error(`Harness behavioral evaluation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
