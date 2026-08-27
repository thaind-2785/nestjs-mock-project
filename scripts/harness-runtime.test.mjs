import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadHarness } from './harness-check.mjs';
import {
  authorizeCommand,
  buildChildEnvironment,
  commandCatalog,
  evaluateCommandPolicy,
  executeCommand,
  HarnessPolicyError,
  resolveCommand,
  selectContext,
  validateTraceEvent,
  verifyCommandIntegrity,
} from './harness-runtime.mjs';

const loaded = loadHarness();
const discardTrace = () => {};

function expectPolicyError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof HarnessPolicyError);
    assert.equal(error.code, code);
    return true;
  });
}

test('resolves a reviewed active command without spawning', () => {
  const resolved = resolveCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
  });

  assert.equal(resolved.commandRef, 'build');
  assert.equal(resolved.toolId, 'npm');
  assert.equal(resolved.permissionId, 'run_local_checks');
  assert.equal(resolved.environmentId, 'local');
  assert.equal(resolved.timeoutMs, 900_000);
  assert.deepEqual(resolved.args, commandCatalog.build.args);
  assert.equal(resolved.executable, process.execPath);
  assert.match(resolved.args[0], /npm-cli\.js$/);
});

test('implements every manifest entry command with fixed argv', () => {
  assert.deepEqual(
    Object.keys(commandCatalog).sort(),
    Object.keys(loaded.config.entry_commands).sort(),
  );
  for (const [commandRef, entry] of Object.entries(
    loaded.config.entry_commands,
  )) {
    const environmentId = entry.environments.includes('local') ? 'local' : 'ci';
    assert.doesNotThrow(() =>
      resolveCommand({
        config: loaded.config,
        commandRef,
        environmentId,
      }),
    );
  }
});

test('rejects unknown and unimplemented command references', () => {
  expectPolicyError(
    () =>
      resolveCommand({
        config: loaded.config,
        commandRef: 'unknown',
        environmentId: 'local',
      }),
    'unknown_command_ref',
  );

  const catalog = { ...commandCatalog };
  delete catalog.build;
  expectPolicyError(
    () =>
      resolveCommand({
        config: loaded.config,
        commandRef: 'build',
        environmentId: 'local',
        catalog,
      }),
    'missing_command_implementation',
  );
});

test('rejects manifest drift instead of executing manifest command text', () => {
  const config = structuredClone(loaded.config);
  config.entry_commands.build.command = 'node arbitrary-user-text.js';

  expectPolicyError(
    () =>
      resolveCommand({
        config,
        commandRef: 'build',
        environmentId: 'local',
      }),
    'command_implementation_drift',
  );
});

test('rejects missing bootstrap integrity policy before execution', () => {
  const config = structuredClone(loaded.config);
  delete config.entry_commands.bootstrap.integrity_policy;
  expectPolicyError(
    () =>
      resolveCommand({
        config,
        commandRef: 'bootstrap',
        environmentId: 'local',
      }),
    'command_integrity_policy_drift',
  );
});

test('rejects planned tools and environments before spawn', () => {
  const plannedTool = structuredClone(loaded.config);
  plannedTool.tool_registry.find((tool) => tool.id === 'npm').status =
    'planned';
  expectPolicyError(
    () =>
      resolveCommand({
        config: plannedTool,
        commandRef: 'build',
        environmentId: 'local',
      }),
    'planned_tool',
  );

  expectPolicyError(
    () =>
      resolveCommand({
        config: loaded.config,
        commandRef: 'build',
        environmentId: 'staging',
      }),
    'planned_environment',
  );
});

test('rejects command/environment and environment/tool mismatches', () => {
  expectPolicyError(
    () =>
      resolveCommand({
        config: loaded.config,
        commandRef: 'dev',
        environmentId: 'ci',
      }),
    'unsupported_environment',
  );

  const config = structuredClone(loaded.config);
  config.runtime_contract.environments.local.dependencies = [
    'node',
    'git_read',
  ];
  expectPolicyError(
    () =>
      resolveCommand({
        config,
        commandRef: 'build',
        environmentId: 'local',
      }),
    'environment_tool_mismatch',
  );
});

test('allows registered permissions within active autonomy', () => {
  const build = resolveCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
  });
  assert.deepEqual(
    authorizeCommand({ config: loaded.config, resolvedCommand: build }),
    {
      decision: 'allow',
      reasonCode: 'allow',
      autonomyLevelId: 'L2',
    },
  );

  const dev = resolveCommand({
    config: loaded.config,
    commandRef: 'dev',
    environmentId: 'local',
  });
  assert.equal(
    authorizeCommand({ config: loaded.config, resolvedCommand: dev })
      .reasonCode,
    'allow',
  );
});

test('rejects denied, approval-required, and autonomy-incompatible permissions', () => {
  const build = resolveCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
  });
  const denied = structuredClone(loaded.config);
  denied.entry_commands.build.permission = 'read_secrets';
  denied.tool_registry
    .find((tool) => tool.id === 'npm')
    .permissions.push('read_secrets');
  const deniedBuild = { ...build, permissionId: 'read_secrets' };
  expectPolicyError(
    () => authorizeCommand({ config: denied, resolvedCommand: deniedBuild }),
    'denied_permission',
  );

  const approvalRequired = structuredClone(loaded.config);
  approvalRequired.entry_commands.build.permission = 'install_dependencies';
  const approvalBuild = { ...build, permissionId: 'install_dependencies' };
  const approvalDecision = evaluateCommandPolicy({
    config: approvalRequired,
    resolvedCommand: approvalBuild,
  });
  assert.equal(approvalDecision.decision, 'approval_required');
  expectPolicyError(
    () =>
      authorizeCommand({
        config: approvalRequired,
        resolvedCommand: approvalBuild,
      }),
    'approval_artifact_unavailable',
  );

  const dev = resolveCommand({
    config: loaded.config,
    commandRef: 'dev',
    environmentId: 'local',
  });
  expectPolicyError(
    () =>
      authorizeCommand({
        config: loaded.config,
        resolvedCommand: dev,
        autonomyLevelId: 'L0',
      }),
    'autonomy_permission_mismatch',
  );
});

test('rejects unknown and planned autonomy levels', () => {
  const build = resolveCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
  });
  expectPolicyError(
    () =>
      authorizeCommand({
        config: loaded.config,
        resolvedCommand: build,
        autonomyLevelId: 'L99',
      }),
    'unknown_autonomy_level',
  );
  expectPolicyError(
    () =>
      authorizeCommand({
        config: loaded.config,
        resolvedCommand: build,
        autonomyLevelId: 'L3',
      }),
    'planned_autonomy_level',
  );
});

test('forwards only explicit child environment values', () => {
  const resolved = resolveCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'ci',
  });
  const childEnvironment = buildChildEnvironment({
    config: loaded.config,
    resolvedCommand: resolved,
    ambientEnvironment: {
      PATH: '/synthetic/bin',
      CI: 'true',
      NODE_ENV: 'test',
      HARNESS_TEST_SECRET_SENTINEL: 'must-not-cross',
      PROVIDER_TOKEN: 'must-not-cross',
      UNDECLARED_VALUE: 'must-not-cross',
    },
    internalEnvironment: {
      HARNESS_COMMAND_REF: 'build',
      HARNESS_ENVIRONMENT: 'ci',
    },
  });

  assert.equal(childEnvironment.PATH, '/synthetic/bin');
  assert.equal(childEnvironment.CI, 'true');
  assert.equal(childEnvironment.NODE_ENV, 'test');
  assert.equal(childEnvironment.HARNESS_COMMAND_REF, 'build');
  assert.equal('HARNESS_TEST_SECRET_SENTINEL' in childEnvironment, false);
  assert.equal('PROVIDER_TOKEN' in childEnvironment, false);
  assert.equal('UNDECLARED_VALUE' in childEnvironment, false);
});

test('rejects unsafe allowlists, missing PATH, and unknown internal values', () => {
  const resolved = resolveCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
  });
  const unsafe = structuredClone(loaded.config);
  unsafe.runtime_contract.child_environment.base_allowlist.push(
    'PROVIDER_TOKEN',
  );
  expectPolicyError(
    () =>
      buildChildEnvironment({
        config: unsafe,
        resolvedCommand: resolved,
        ambientEnvironment: { PATH: '/synthetic/bin' },
      }),
    'unsafe_environment_allowlist',
  );

  for (const environmentName of [
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'NPM_CONFIG_USERCONFIG',
  ]) {
    const executionControl = structuredClone(loaded.config);
    const dangerousResolved = {
      ...resolved,
      forwardEnv: [environmentName],
    };
    expectPolicyError(
      () =>
        buildChildEnvironment({
          config: executionControl,
          resolvedCommand: dangerousResolved,
          ambientEnvironment: {
            PATH: '/synthetic/bin',
            [environmentName]: 'attacker-controlled',
          },
        }),
      'unsafe_environment_allowlist',
    );
  }

  expectPolicyError(
    () =>
      buildChildEnvironment({
        config: loaded.config,
        resolvedCommand: resolved,
        ambientEnvironment: { CI: 'true' },
      }),
    'missing_executable_path',
  );

  expectPolicyError(
    () =>
      buildChildEnvironment({
        config: loaded.config,
        resolvedCommand: resolved,
        ambientEnvironment: { PATH: '/synthetic/bin' },
        internalEnvironment: { ARBITRARY_INTERNAL_VALUE: 'no' },
      }),
    'unsafe_internal_environment',
  );
});

function executableFixture({ source, timeoutSeconds = 2 }) {
  const config = structuredClone(loaded.config);
  const args = ['-e', source];
  config.entry_commands.fixture = {
    command: [process.execPath, ...args].join(' '),
    tool_ref: 'node',
    permission: 'run_local_checks',
    environments: ['local'],
  };
  config.tool_registry.find((tool) => tool.id === 'node').timeout_seconds =
    timeoutSeconds;
  const catalog = {
    ...commandCatalog,
    fixture: { executable: process.execPath, args },
  };
  return { config, catalog };
}

test('executor spawns only reviewed argv with shell disabled', () => {
  let call;
  const spawn = (...args) => {
    call = args;
    return { status: 0, signal: null, stdout: '', stderr: '' };
  };

  const result = executeCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
    ambientEnvironment: { PATH: '/synthetic/bin' },
    stdio: 'pipe',
    spawn,
    traceSink: discardTrace,
  });

  assert.equal(result.status, 0);
  assert.equal(call[0], commandCatalog.build.executable);
  assert.deepEqual(call[1], commandCatalog.build.args);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].env.HARNESS_COMMAND_REF, 'build');
});

test('executor rejects unknown, drifted, and policy-blocked commands before spawn', () => {
  let spawnCount = 0;
  const spawn = () => {
    spawnCount += 1;
    return { status: 0 };
  };

  expectPolicyError(
    () =>
      executeCommand({
        config: loaded.config,
        commandRef: 'build && arbitrary-command',
        environmentId: 'local',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        spawn,
        traceSink: discardTrace,
      }),
    'unknown_command_ref',
  );

  const drifted = structuredClone(loaded.config);
  drifted.entry_commands.build.command = 'npm run build && arbitrary-command';
  expectPolicyError(
    () =>
      executeCommand({
        config: drifted,
        commandRef: 'build',
        environmentId: 'local',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        spawn,
        traceSink: discardTrace,
      }),
    'command_implementation_drift',
  );

  expectPolicyError(
    () =>
      executeCommand({
        config: loaded.config,
        commandRef: 'dev',
        environmentId: 'local',
        autonomyLevelId: 'L0',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        spawn,
        traceSink: discardTrace,
      }),
    'autonomy_permission_mismatch',
  );

  const denied = structuredClone(loaded.config);
  denied.entry_commands.build.permission = 'read_secrets';
  denied.tool_registry
    .find((tool) => tool.id === 'npm')
    .permissions.push('read_secrets');
  expectPolicyError(
    () =>
      executeCommand({
        config: denied,
        commandRef: 'build',
        environmentId: 'local',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        spawn,
        traceSink: discardTrace,
      }),
    'denied_permission',
  );

  const approvalRequired = structuredClone(loaded.config);
  approvalRequired.entry_commands.build.permission = 'install_dependencies';
  expectPolicyError(
    () =>
      executeCommand({
        config: approvalRequired,
        commandRef: 'build',
        environmentId: 'local',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        spawn,
        traceSink: discardTrace,
      }),
    'approval_artifact_unavailable',
  );
  assert.equal(spawnCount, 0);
});

test('executor preserves successful and non-zero child results', () => {
  const successful = executableFixture({
    source: 'process.stdout.write("fixture-ok")',
  });
  const result = executeCommand({
    ...successful,
    commandRef: 'fixture',
    environmentId: 'local',
    ambientEnvironment: process.env,
    stdio: 'pipe',
    traceSink: discardTrace,
  });
  assert.equal(result.stdout, 'fixture-ok');

  const failing = executableFixture({ source: 'process.exit(7)' });
  expectPolicyError(
    () =>
      executeCommand({
        ...failing,
        commandRef: 'fixture',
        environmentId: 'local',
        ambientEnvironment: process.env,
        stdio: 'pipe',
        traceSink: discardTrace,
      }),
    'child_nonzero_exit',
  );
});

test('committed dependency integrity rejects unstaged and staged graph drift', () => {
  const repository = mkdtempSync(join(tmpdir(), 'harness-dependency-'));
  const packageJson = '{"name":"fixture","version":"1.0.0"}\n';
  const packageLock =
    '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n';
  const runGit = (args) =>
    execFileSync('git', args, { cwd: repository, stdio: 'ignore' });

  try {
    runGit(['init', '--quiet']);
    writeFileSync(join(repository, 'package.json'), packageJson);
    writeFileSync(join(repository, 'package-lock.json'), packageLock);
    runGit(['add', 'package.json', 'package-lock.json']);
    runGit([
      '-c',
      'user.name=Harness Test',
      '-c',
      'user.email=harness@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);

    const resolvedCommand = resolveCommand({
      config: loaded.config,
      commandRef: 'bootstrap',
      environmentId: 'local',
    });
    assert.doesNotThrow(() =>
      verifyCommandIntegrity({ resolvedCommand, cwd: repository }),
    );

    writeFileSync(
      join(repository, 'package-lock.json'),
      packageLock.replace('1.0.0', '2.0.0'),
    );
    expectPolicyError(
      () => verifyCommandIntegrity({ resolvedCommand, cwd: repository }),
      'dependency_graph_drift',
    );

    runGit(['add', 'package-lock.json']);
    expectPolicyError(
      () => verifyCommandIntegrity({ resolvedCommand, cwd: repository }),
      'dependency_graph_drift',
    );

    writeFileSync(join(repository, 'package-lock.json'), packageLock);
    runGit(['add', 'package-lock.json']);
    assert.doesNotThrow(() =>
      verifyCommandIntegrity({ resolvedCommand, cwd: repository }),
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('bootstrap integrity failure blocks the child spawn', () => {
  let spawnCount = 0;
  expectPolicyError(
    () =>
      executeCommand({
        config: loaded.config,
        commandRef: 'bootstrap',
        environmentId: 'local',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        spawn: () => {
          spawnCount += 1;
          return { status: 0 };
        },
        integrityCheck: () => {
          throw new HarnessPolicyError(
            'dependency_graph_drift',
            'synthetic dependency graph drift',
          );
        },
        traceSink: discardTrace,
      }),
    'dependency_graph_drift',
  );
  assert.equal(spawnCount, 0);
});

test('dependency integrity invokes an absolute approved Git path without ambient PATH', () => {
  const resolvedCommand = resolveCommand({
    config: loaded.config,
    commandRef: 'bootstrap',
    environmentId: 'local',
  });
  let invocation;
  verifyCommandIntegrity({
    resolvedCommand,
    cwd: '/synthetic/repository',
    gitExecutable: '/trusted/bin/git',
    git: (...args) => {
      invocation = args;
    },
  });

  assert.equal(invocation[0], '/trusted/bin/git');
  assert.deepEqual(invocation[1].slice(0, 4), [
    'diff',
    '--quiet',
    'HEAD',
    '--',
  ]);
  assert.equal('PATH' in invocation[2].env, false);
  assert.equal('Path' in invocation[2].env, false);
});

test('executor classifies child timeout without executing through a shell', () => {
  const fixture = executableFixture({
    source: 'setInterval(() => {}, 1000)',
    timeoutSeconds: 0.05,
  });
  expectPolicyError(
    () =>
      executeCommand({
        ...fixture,
        commandRef: 'fixture',
        environmentId: 'local',
        ambientEnvironment: process.env,
        stdio: 'pipe',
        traceSink: discardTrace,
      }),
    'child_timeout',
  );
});

test('emits correlated allowlisted traces without ambient secret values', () => {
  const events = [];
  const times = [1000, 1001, 1002, 1012];
  const result = executeCommand({
    config: loaded.config,
    commandRef: 'build',
    environmentId: 'local',
    ambientEnvironment: {
      PATH: '/synthetic/bin',
      PROVIDER_TOKEN: 'trace-secret-sentinel',
    },
    stdio: 'pipe',
    spawn: () => ({ status: 0, signal: null, stdout: '', stderr: '' }),
    traceSink: (event) => events.push(event),
    traceId: 'trace-001',
    routeId: 'repository_verification',
    contextSourceIds: ['project_rules', 'test_strategy'],
    clock: () => times.shift() ?? 1012,
  });

  assert.equal(result.traceId, 'trace-001');
  assert.equal(result.durationMs, 11);
  assert.deepEqual(
    events.map((event) => event.event),
    ['policy_decision', 'command_started', 'command_completed'],
  );
  assert.ok(events.every((event) => event.trace_id === 'trace-001'));
  assert.equal(events[0].decision, 'allow');
  assert.equal(events[2].duration_ms, 11);
  assert.equal(events[2].exit_code, 0);
  assert.equal(JSON.stringify(events).includes('trace-secret-sentinel'), false);
  assert.equal(JSON.stringify(events).includes('PROVIDER_TOKEN'), false);
});

test('trace schema rejects unallowlisted fields and unrestricted values', () => {
  const base = {
    schema_version: '0.2',
    timestamp: new Date(0).toISOString(),
    trace_id: 'trace-002',
    event: 'command_started',
  };
  expectPolicyError(
    () => validateTraceEvent({ ...base, environment_value: 'secret' }),
    'unsafe_trace_field',
  );
  expectPolicyError(
    () =>
      validateTraceEvent({ ...base, route_id: 'raw task text with spaces' }),
    'unsafe_trace_value',
  );
  expectPolicyError(
    () =>
      validateTraceEvent({
        ...base,
        command_ref: 'build',
        autonomy_level: 'L2',
        decision: 'allow',
        status: 'blocked',
        failure_class: 'denied_permission',
      }),
    'invalid_trace_event_shape',
  );
});

test('trace sink failure blocks execution instead of failing open', () => {
  let spawnCount = 0;
  assert.throws(
    () =>
      executeCommand({
        config: loaded.config,
        commandRef: 'build',
        environmentId: 'local',
        ambientEnvironment: { PATH: '/synthetic/bin' },
        traceSink: () => {
          throw new Error('synthetic_trace_sink_failure');
        },
        spawn: () => {
          spawnCount += 1;
          return { status: 0 };
        },
      }),
    /synthetic_trace_sink_failure/,
  );
  assert.equal(spawnCount, 0);
});

test('selects progressive context from the canonical task-class routes', () => {
  const selected = selectContext({
    config: loaded.config,
    taskClasses: ['api', 'implementation'],
  });

  assert.deepEqual(selected.routeIds, ['api_product', 'implementation_review']);
  assert.deepEqual(selected.sourceIds, [
    'project_rules',
    'handbook_router',
    'normalized_scope',
    'api_catalog',
    'test_strategy',
  ]);
  assert.equal(selected.sources[3].path, 'docs/api/endpoint-catalog.md');
});

test('uses a bounded fallback and rejects free-form task text', () => {
  const fallback = selectContext({
    config: loaded.config,
    taskClasses: ['unmatched_class'],
  });
  assert.deepEqual(fallback.routeIds, ['repository_baseline']);
  assert.deepEqual(fallback.sourceIds, ['project_rules', 'handbook_router']);

  expectPolicyError(
    () =>
      selectContext({
        config: loaded.config,
        taskClasses: ['please inspect this arbitrary task'],
      }),
    'invalid_task_class',
  );
});

test('context routing fails closed when a canonical source reference drifts', () => {
  const config = structuredClone(loaded.config);
  config.context_strategy.routes[0].source_ids = ['missing_source'];
  expectPolicyError(
    () => selectContext({ config, taskClasses: ['scope'] }),
    'unknown_context_source',
  );
});
