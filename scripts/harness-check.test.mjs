import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  loadHarness,
  loadTrackedPaths,
  validateCiWorkflow,
  validateHarness,
  validateRepositoryPath,
} from './harness-check.mjs';

const loaded = loadHarness();

function validate(config, packageJson = loaded.packageJson) {
  return validateHarness(
    config,
    packageJson,
    loaded.rootDirectory,
    loaded.schema,
  );
}

test('accepts the repository harness manifest', () => {
  assert.deepEqual(validate(loaded.config), []);
});

test('loads machine config only from .harness and normalized product scope', () => {
  assert.equal(
    existsSync(resolve(loaded.rootDirectory, '.harness/manifest.yaml')),
    true,
  );
  assert.equal(
    existsSync(resolve(loaded.rootDirectory, '.harness/schema.json')),
    true,
  );
  assert.equal(
    existsSync(resolve(loaded.rootDirectory, 'harness.yaml')),
    false,
  );
  assert.equal(
    existsSync(resolve(loaded.rootDirectory, 'harness.schema.json')),
    false,
  );
  assert.equal(existsSync(resolve(loaded.rootDirectory, 'feature.md')), false);
  assert.deepEqual(
    loaded.config.memory_model.records
      .filter((record) => record.id.includes('scope'))
      .map((record) => record.path),
    ['docs/product/feature-scope.md'],
  );
});

test('rejects every required top-level section when null', async (t) => {
  const sections = [
    'project',
    'entry_commands',
    'workflow',
    'context_strategy',
    'tool_registry',
    'permission_model',
    'hook_lifecycle',
    'skill_boundaries',
    'memory_model',
    'observability',
    'evaluation_strategy',
    'pr_lifecycle',
    'autonomy_levels',
    'runtime_contract',
  ];

  for (const section of sections) {
    await t.test(section, () => {
      const config = structuredClone(loaded.config);
      config[section] = null;
      assert.ok(validate(config).some((error) => error.includes(section)));
    });
  }
});

test('rejects empty required collections', () => {
  const mutations = [
    (config) => (config.entry_commands = {}),
    (config) => (config.workflow.states = []),
    (config) => (config.context_strategy.sources = []),
    (config) => (config.context_strategy.routes = []),
    (config) => (config.tool_registry = []),
    (config) => (config.permission_model.actions = {}),
    (config) => (config.hook_lifecycle.hooks = []),
    (config) => (config.skill_boundaries.skills = []),
    (config) => (config.memory_model.records = []),
    (config) => (config.observability.harness_events = []),
    (config) => (config.evaluation_strategy.evaluations = []),
    (config) => (config.pr_lifecycle.required_commands = []),
    (config) => (config.autonomy_levels.levels = []),
    (config) => (config.runtime_contract.environments = {}),
  ];

  for (const mutate of mutations) {
    const config = structuredClone(loaded.config);
    mutate(config);
    assert.notDeepEqual(validate(config), []);
  }
});

test('rejects a missing npm script and command drift', () => {
  const missingScript = structuredClone(loaded.config);
  missingScript.entry_commands.verify.npm_script = 'missing:script';
  assert.ok(
    validate(missingScript).some((error) =>
      error.includes('references missing package script "missing:script"'),
    ),
  );

  const commandDrift = structuredClone(loaded.config);
  commandDrift.entry_commands.verify.command = 'npm run build';
  assert.ok(
    validate(commandDrift).some((error) =>
      error.includes('must equal "npm run verify"'),
    ),
  );
});

test('requires bootstrap dependency integrity in schema and semantics', () => {
  const config = structuredClone(loaded.config);
  delete config.entry_commands.bootstrap.integrity_policy;
  assert.ok(
    validate(config).some((error) => error.includes('integrity_policy')),
  );
});

test('rejects unknown permissions and planned command tools', () => {
  const unknownPermission = structuredClone(loaded.config);
  unknownPermission.entry_commands.verify.permission = 'unknown';
  assert.ok(
    validate(unknownPermission).some((error) =>
      error.includes('references unknown action "unknown"'),
    ),
  );

  const plannedTool = structuredClone(loaded.config);
  plannedTool.tool_registry.find((tool) => tool.id === 'npm').status =
    'planned';
  assert.ok(
    validate(plannedTool).some((error) =>
      error.includes('references non-active tool "npm"'),
    ),
  );
});

test('rejects execution-control environment forwarding', () => {
  for (const environmentName of [
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NPM_CONFIG_USERCONFIG',
  ]) {
    const config = structuredClone(loaded.config);
    config.entry_commands.build.forward_env.push(environmentName);
    assert.ok(
      validate(config).some((error) =>
        error.includes('not in the implementation forward allowlist'),
      ),
    );
  }
});

test('requires implementation evidence for active tools', () => {
  const config = structuredClone(loaded.config);
  const docker = config.tool_registry.find(
    (tool) => tool.id === 'docker_compose',
  );
  delete docker.implementation_ref;

  assert.ok(
    validate(config).some((error) =>
      error.includes('is required for an active tool'),
    ),
  );
});

test('requires implementation evidence for active observability', () => {
  const activeSink = structuredClone(loaded.config);
  const applicationLogs = activeSink.observability.sinks.find(
    (sink) => sink.id === 'application_json_logs',
  );
  applicationLogs.status = 'active';
  assert.ok(
    validate(activeSink).some((error) =>
      error.includes('is required for an active sink'),
    ),
  );

  const activeEvent = structuredClone(loaded.config);
  activeEvent.observability.harness_events[0].emitter = 'missing-emitter.mjs';
  assert.ok(
    validate(activeEvent).some((error) =>
      error.includes('missing-emitter.mjs'),
    ),
  );
});

test('rejects observability registry drift from the runtime trace schema', () => {
  const fieldDrift = structuredClone(loaded.config);
  fieldDrift.observability.allowed_fields.pop();
  assert.ok(
    validate(fieldDrift).some((error) =>
      error.includes('must exactly match the runtime trace field allowlist'),
    ),
  );

  const eventDrift = structuredClone(loaded.config);
  eventDrift.observability.harness_events.find(
    (event) => event.id === 'command_completed',
  ).status = 'manual';
  assert.ok(
    validate(eventDrift).some((error) =>
      error.includes('must exactly match the runtime trace event registry'),
    ),
  );
});

test('rejects unknown workflow states', () => {
  const config = structuredClone(loaded.config);
  config.workflow.transitions[0].to = 'unknown';
  assert.ok(
    validate(config).some((error) => error.includes('unknown workflow state')),
  );
});

test('rejects context source drift, duplicate routing, and stale mirrors', () => {
  const unknownSource = structuredClone(loaded.config);
  unknownSource.context_strategy.routes[0].source_ids = ['missing_source'];
  assert.ok(
    validate(unknownSource).some((error) =>
      error.includes('references unknown context source "missing_source"'),
    ),
  );

  const duplicateTaskClass = structuredClone(loaded.config);
  duplicateTaskClass.context_strategy.routes[1].task_classes.push('scope');
  assert.ok(
    validate(duplicateTaskClass).some((error) =>
      error.includes('task class "scope" is assigned to multiple routes'),
    ),
  );

  const staleMirror = structuredClone(loaded.config);
  staleMirror.context_strategy.mirror_marker = 'STALE_CONTEXT_MARKER';
  assert.ok(
    validate(staleMirror).some((error) =>
      error.includes('must contain marker "STALE_CONTEXT_MARKER" exactly once'),
    ),
  );
});

test('rejects missing, absolute, and escaping paths', () => {
  const missing = structuredClone(loaded.config);
  missing.context_strategy.sources[0].path = 'missing-context.md';
  assert.ok(
    validate(missing).some((error) => error.includes('missing-context.md')),
  );

  const absolute = structuredClone(loaded.config);
  absolute.memory_model.records[0].path = '/etc/passwd';
  assert.ok(validate(absolute).some((error) => error.includes('not absolute')));

  const escaping = structuredClone(loaded.config);
  escaping.memory_model.records[0].path = '../outside';
  assert.ok(
    validate(escaping).some((error) => error.includes('escape the repository')),
  );
});

test('rejects a local artifact that is not tracked by Git', () => {
  const temporaryRoot = resolve(loaded.rootDirectory, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const sandbox = mkdtempSync(join(temporaryRoot, 'harness-untracked-'));
  const localOnlyFile = join(sandbox, 'local-only.md');
  writeFileSync(localOnlyFile, 'local only');

  try {
    const config = structuredClone(loaded.config);
    config.memory_model.records[0].path = relative(
      loaded.rootDirectory,
      localOnlyFile,
    );
    assert.ok(
      validate(config).some((error) => error.includes('must be Git-tracked')),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('does not treat an intent-to-add file as clean-checkout evidence', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'harness-git-index-'));
  const repository = join(sandbox, 'repository');
  mkdirSync(repository);
  writeFileSync(join(repository, 'artifact.md'), 'artifact');

  try {
    execFileSync('git', ['init', '--quiet'], {
      cwd: repository,
      stdio: 'ignore',
    });
    execFileSync('git', ['add', '-N', 'artifact.md'], {
      cwd: repository,
      stdio: 'ignore',
    });
    assert.equal(loadTrackedPaths(repository).paths.has('artifact.md'), false);

    execFileSync('git', ['add', 'artifact.md'], {
      cwd: repository,
      stdio: 'ignore',
    });
    assert.equal(loadTrackedPaths(repository).paths.has('artifact.md'), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('rejects symlinks that leave the repository', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'harness-path-'));
  const repository = join(sandbox, 'repository');
  const outside = join(sandbox, 'outside.txt');
  mkdirSync(repository);
  writeFileSync(outside, 'outside');
  symlinkSync(outside, join(repository, 'escape'));

  try {
    assert.match(
      validateRepositoryPath(repository, 'escape', 'file'),
      /symlink target must remain inside/,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('rejects runtime drift from package engines and version file', () => {
  const engineDrift = structuredClone(loaded.config);
  engineDrift.runtime_contract.node_engine = '>=20';
  assert.ok(
    validate(engineDrift).some((error) =>
      error.includes('must match package.json engines.node'),
    ),
  );

  const versionDrift = structuredClone(loaded.config);
  versionDrift.runtime_contract.node_major = 20;
  assert.ok(
    validate(versionDrift).some((error) =>
      error.includes('does not match .nvmrc'),
    ),
  );
});

test('locks CI triggers, permissions, timeout, command, and action pins', () => {
  const workflowPath = resolve(
    loaded.rootDirectory,
    loaded.config.runtime_contract.ci_workflow,
  );
  const workflow = parse(readFileSync(workflowPath, 'utf8'));
  assert.deepEqual(validateCiWorkflow(workflow, loaded.config), []);

  const unsafe = structuredClone(workflow);
  delete unsafe.on.pull_request;
  unsafe.permissions.contents = 'write';
  unsafe.jobs.verify['timeout-minutes'] = 21;
  unsafe.jobs.verify.steps[0].uses = 'actions/checkout@v4';
  unsafe.jobs.verify.steps.find((step) => step.run === 'npm run verify').run =
    'npm run build';
  unsafe.jobs.verify.permissions = { contents: 'write' };
  unsafe.jobs.unreviewed = {
    'runs-on': 'ubuntu-latest',
    permissions: { contents: 'write' },
    steps: [{ run: 'arbitrary-command' }],
  };

  const errors = validateCiWorkflow(unsafe, loaded.config);
  assert.ok(errors.some((error) => error.includes('pull_request')));
  assert.ok(errors.some((error) => error.includes('contents: read')));
  assert.ok(errors.some((error) => error.includes('no greater than 20')));
  assert.ok(errors.some((error) => error.includes('40-character commit SHA')));
  assert.ok(
    errors.some((error) => error.includes('must run "npm run verify"')),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('must contain only the reviewed verify job'),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('job-level permission overrides are forbidden'),
    ),
  );
  assert.ok(
    errors.some((error) => error.includes('is not a reviewed CI step')),
  );

  const stepEnvironment = structuredClone(workflow);
  stepEnvironment.jobs.verify.steps[3].env = {
    NODE_OPTIONS: '--require ./attacker-controlled.js',
  };
  assert.ok(
    validateCiWorkflow(stepEnvironment, loaded.config).some((error) =>
      error.includes('must match the reviewed step shape and order'),
    ),
  );

  const reordered = structuredClone(workflow);
  [reordered.jobs.verify.steps[2], reordered.jobs.verify.steps[3]] = [
    reordered.jobs.verify.steps[3],
    reordered.jobs.verify.steps[2],
  ];
  assert.ok(
    validateCiWorkflow(reordered, loaded.config).some((error) =>
      error.includes('must match the reviewed step shape and order'),
    ),
  );
});
