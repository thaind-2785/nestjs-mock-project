import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class HarnessPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HarnessPolicyError';
    this.code = code;
    this.details = details;
  }
}

const secretLikeEnvironmentName =
  /(?:^|_)(?:AUTH|COOKIE|CREDENTIAL|KEY|PASS|PASSWORD|SECRET|TOKEN)(?:_|$)/i;
const internalEnvironmentNames = new Set([
  'HARNESS_AUTONOMY_LEVEL',
  'HARNESS_COMMAND_REF',
  'HARNESS_ENVIRONMENT',
  'HARNESS_TRACE_ID',
]);
const safeBaseEnvironmentNames = new Set(
  [
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'COMSPEC',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TMP',
    'TEMP',
  ].map((name) => name.toUpperCase()),
);
const safeForwardEnvironmentNames = new Set(
  ['CI', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'PORT'].map((name) =>
    name.toUpperCase(),
  ),
);
export const harnessTraceFieldNames = Object.freeze([
  'schema_version',
  'timestamp',
  'trace_id',
  'event',
  'route_id',
  'context_source_ids',
  'command_ref',
  'tool_id',
  'permission_id',
  'environment_id',
  'autonomy_level',
  'decision',
  'status',
  'duration_ms',
  'retry_count',
  'exit_code',
  'failure_class',
]);
const traceFields = new Set(harnessTraceFieldNames);
export const harnessTraceEventNames = Object.freeze([
  'policy_decision',
  'command_started',
  'command_completed',
  'command_failed',
  'verification_completed',
]);
const traceEvents = new Set(harnessTraceEventNames);
const traceDecisions = new Set(['allow', 'reject', 'approval_required']);
const traceStatuses = new Set(['started', 'succeeded', 'failed', 'blocked']);
const safeTraceId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const traceBaseFields = [
  'schema_version',
  'timestamp',
  'trace_id',
  'event',
  'route_id',
  'context_source_ids',
];
const commandTraceFields = [
  'command_ref',
  'tool_id',
  'permission_id',
  'environment_id',
  'autonomy_level',
  'decision',
  'status',
  'duration_ms',
  'retry_count',
  'exit_code',
  'failure_class',
];
const traceEventAllowedFields = {
  policy_decision: new Set([
    ...traceBaseFields,
    'command_ref',
    'tool_id',
    'permission_id',
    'environment_id',
    'autonomy_level',
    'decision',
    'status',
    'failure_class',
  ]),
  command_started: new Set([...traceBaseFields, ...commandTraceFields]),
  command_completed: new Set([...traceBaseFields, ...commandTraceFields]),
  command_failed: new Set([...traceBaseFields, ...commandTraceFields]),
  verification_completed: new Set([
    ...traceBaseFields,
    'status',
    'retry_count',
    'exit_code',
    'failure_class',
  ]),
};

function isInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..')
  );
}

function resolveNpmCliPath() {
  const executableDirectory = dirname(realpathSync(process.execPath));
  const installationRoot =
    process.platform === 'win32'
      ? executableDirectory
      : resolve(executableDirectory, '..');
  const candidates = [
    resolve(installationRoot, 'lib/node_modules/npm/bin/npm-cli.js'),
    resolve(installationRoot, 'node_modules/npm/bin/npm-cli.js'),
  ];
  if (process.env.npm_execpath) candidates.unshift(process.env.npm_execpath);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const realCandidate = realpathSync(candidate);
    if (
      isInside(installationRoot, realCandidate) &&
      realCandidate.replaceAll('\\', '/').endsWith('/npm/bin/npm-cli.js')
    ) {
      return realCandidate;
    }
  }
  throw new HarnessPolicyError(
    'npm_cli_unavailable',
    'Cannot locate a trusted npm CLI inside the active Node installation',
  );
}

const npmCliPath = resolveNpmCliPath();
function npmCommand(args, integrityPolicy = null) {
  return Object.freeze({
    executable: process.execPath,
    args: Object.freeze([npmCliPath, ...args]),
    displayCommand: ['npm', ...args].join(' '),
    integrityPolicy,
  });
}

export const commandCatalog = Object.freeze({
  bootstrap: npmCommand(['ci'], 'committed_dependency_graph'),
  harness_check: npmCommand(['run', 'harness:check']),
  harness_test: npmCommand(['run', 'test:harness']),
  harness_eval: npmCommand(['run', 'harness:eval']),
  verify: npmCommand(['run', 'verify']),
  dev: npmCommand(['run', 'start:dev']),
  build: npmCommand(['run', 'build']),
  format_check: npmCommand(['run', 'format:check']),
  lint_check: npmCommand(['run', 'lint:check']),
  unit_test: npmCommand(['run', 'test:unit']),
  integration_test: npmCommand(['run', 'test:integration']),
  e2e_test: npmCommand(['run', 'test:e2e']),
});

export function isSecretLikeEnvName(name) {
  return secretLikeEnvironmentName.test(name);
}

export function isAllowedChildEnvironmentName(name, kind) {
  const normalizedName = String(name).toUpperCase();
  return kind === 'base'
    ? safeBaseEnvironmentNames.has(normalizedName)
    : kind === 'forward'
      ? safeForwardEnvironmentNames.has(normalizedName)
      : false;
}

export function selectContext({ config, taskClasses = [] }) {
  if (!Array.isArray(taskClasses)) {
    throw new HarnessPolicyError(
      'invalid_task_classes',
      'Harness context routing requires an array of task-class identifiers',
    );
  }
  for (const taskClass of taskClasses) {
    if (typeof taskClass !== 'string' || !safeTraceId.test(taskClass)) {
      throw new HarnessPolicyError(
        'invalid_task_class',
        'Harness task classes must be stable identifiers, not free-form task text',
      );
    }
  }

  const selectedRoutes = config.context_strategy.routes.filter((route) =>
    route.task_classes.some((taskClass) => taskClasses.includes(taskClass)),
  );
  const sourceIds = [
    ...config.context_strategy.fallback_source_ids,
    ...selectedRoutes.flatMap((route) => route.source_ids),
  ].filter((sourceId, index, values) => values.indexOf(sourceId) === index);
  const sourcesById = new Map(
    config.context_strategy.sources.map((source) => [source.id, source]),
  );
  const sources = sourceIds.map((sourceId) => {
    const source = sourcesById.get(sourceId);
    if (!source) {
      throw new HarnessPolicyError(
        'unknown_context_source',
        `Context route references unknown source "${sourceId}"`,
        { context_source_id: sourceId },
      );
    }
    return Object.freeze({
      id: source.id,
      path: source.path,
      pathKind: source.path_kind ?? 'file',
    });
  });

  return Object.freeze({
    routeIds: Object.freeze(
      selectedRoutes.length > 0
        ? selectedRoutes.map((route) => route.id)
        : [config.context_strategy.fallback_route_id],
    ),
    sourceIds: Object.freeze([...sourceIds]),
    sources: Object.freeze(sources),
  });
}

function assertSafeTraceIdentifier(field, value) {
  if (typeof value !== 'string' || !safeTraceId.test(value)) {
    throw new HarnessPolicyError(
      'unsafe_trace_value',
      `Trace field "${field}" must contain a stable non-secret identifier`,
      { trace_field: field },
    );
  }
}

export function validateTraceEvent(event) {
  for (const field of Object.keys(event)) {
    if (!traceFields.has(field)) {
      throw new HarnessPolicyError(
        'unsafe_trace_field',
        `Trace field is not allowlisted: ${field}`,
        { trace_field: field },
      );
    }
  }

  if (event.schema_version !== '0.2') {
    throw new HarnessPolicyError(
      'invalid_trace_schema',
      'Harness trace schema_version must be 0.2',
    );
  }
  if (Number.isNaN(Date.parse(event.timestamp))) {
    throw new HarnessPolicyError(
      'invalid_trace_timestamp',
      'Harness trace timestamp must be an ISO date-time',
    );
  }
  assertSafeTraceIdentifier('trace_id', event.trace_id);
  if (!traceEvents.has(event.event)) {
    throw new HarnessPolicyError(
      'invalid_trace_event',
      `Unknown Harness trace event: ${String(event.event)}`,
    );
  }
  const eventAllowedFields = traceEventAllowedFields[event.event];
  for (const field of Object.keys(event)) {
    if (!eventAllowedFields.has(field)) {
      throw new HarnessPolicyError(
        'invalid_trace_event_shape',
        `Trace field "${field}" is not valid for event "${event.event}"`,
      );
    }
  }

  for (const field of [
    'route_id',
    'command_ref',
    'tool_id',
    'permission_id',
    'environment_id',
    'autonomy_level',
    'failure_class',
  ]) {
    if (event[field] !== undefined)
      assertSafeTraceIdentifier(field, event[field]);
  }
  if (event.context_source_ids !== undefined) {
    if (!Array.isArray(event.context_source_ids)) {
      throw new HarnessPolicyError(
        'unsafe_trace_value',
        'Trace context_source_ids must be an array of stable identifiers',
      );
    }
    for (const value of event.context_source_ids) {
      assertSafeTraceIdentifier('context_source_ids', value);
    }
  }
  if (event.decision !== undefined && !traceDecisions.has(event.decision)) {
    throw new HarnessPolicyError(
      'invalid_trace_decision',
      `Unknown Harness trace decision: ${String(event.decision)}`,
    );
  }
  if (event.status !== undefined && !traceStatuses.has(event.status)) {
    throw new HarnessPolicyError(
      'invalid_trace_status',
      `Unknown Harness trace status: ${String(event.status)}`,
    );
  }
  for (const field of ['duration_ms', 'retry_count']) {
    if (
      event[field] !== undefined &&
      (!Number.isFinite(event[field]) || event[field] < 0)
    ) {
      throw new HarnessPolicyError(
        'unsafe_trace_value',
        `Trace field "${field}" must be a non-negative number`,
      );
    }
  }
  if (
    event.exit_code !== undefined &&
    event.exit_code !== null &&
    !Number.isInteger(event.exit_code)
  ) {
    throw new HarnessPolicyError(
      'unsafe_trace_value',
      'Trace exit_code must be an integer or null',
    );
  }

  const requireFields = (fields) => {
    for (const field of fields) {
      if (event[field] === undefined) {
        throw new HarnessPolicyError(
          'invalid_trace_event_shape',
          `Trace event "${event.event}" requires field "${field}"`,
        );
      }
    }
  };
  if (event.event === 'policy_decision') {
    requireFields(['command_ref', 'autonomy_level', 'decision', 'status']);
    const allowed = event.decision === 'allow';
    if (
      (allowed &&
        (event.status !== 'succeeded' || event.failure_class !== undefined)) ||
      (!allowed &&
        (event.status !== 'blocked' || event.failure_class === undefined))
    ) {
      throw new HarnessPolicyError(
        'invalid_trace_event_shape',
        'Policy decision status/failure fields are inconsistent',
      );
    }
  }
  if (event.event === 'command_started') {
    requireFields([
      'command_ref',
      'tool_id',
      'permission_id',
      'environment_id',
      'autonomy_level',
      'decision',
      'status',
      'retry_count',
    ]);
    if (event.decision !== 'allow' || event.status !== 'started') {
      throw new HarnessPolicyError(
        'invalid_trace_event_shape',
        'Command start must represent an allowed started command',
      );
    }
  }
  if (event.event === 'command_completed') {
    requireFields([
      'command_ref',
      'tool_id',
      'permission_id',
      'environment_id',
      'autonomy_level',
      'decision',
      'status',
      'duration_ms',
      'retry_count',
      'exit_code',
    ]);
    if (
      event.decision !== 'allow' ||
      event.status !== 'succeeded' ||
      event.exit_code !== 0 ||
      event.failure_class !== undefined
    ) {
      throw new HarnessPolicyError(
        'invalid_trace_event_shape',
        'Command completion fields are inconsistent',
      );
    }
  }
  if (event.event === 'command_failed') {
    requireFields([
      'command_ref',
      'tool_id',
      'permission_id',
      'environment_id',
      'autonomy_level',
      'decision',
      'status',
      'duration_ms',
      'retry_count',
      'failure_class',
    ]);
    if (event.decision !== 'allow' || event.status !== 'failed') {
      throw new HarnessPolicyError(
        'invalid_trace_event_shape',
        'Command failure must represent an allowed command that failed',
      );
    }
  }
  if (event.event === 'verification_completed') {
    requireFields(['route_id', 'status', 'retry_count']);
    if (
      !['succeeded', 'failed'].includes(event.status) ||
      (event.status === 'failed') !== (event.failure_class !== undefined)
    ) {
      throw new HarnessPolicyError(
        'invalid_trace_event_shape',
        'Verification terminal status/failure fields are inconsistent',
      );
    }
  }

  return Object.freeze({
    ...event,
    context_source_ids:
      event.context_source_ids === undefined
        ? undefined
        : Object.freeze([...event.context_source_ids]),
  });
}

export function createJsonLineTraceSink(stream = process.stderr) {
  return (event) => stream.write(`${JSON.stringify(event)}\n`);
}

export function emitHarnessTrace(traceSink, event) {
  const validated = validateTraceEvent(event);
  traceSink(validated);
  return validated;
}

function displayCommand(definition) {
  if (definition.displayCommand) return definition.displayCommand;
  const executable = definition.executable.endsWith('.cmd')
    ? definition.executable.slice(0, -4)
    : definition.executable;
  return [executable, ...definition.args].join(' ');
}

export function resolveCommand({
  config,
  commandRef,
  environmentId,
  catalog = commandCatalog,
}) {
  if (
    typeof commandRef !== 'string' ||
    !(commandRef in config.entry_commands)
  ) {
    throw new HarnessPolicyError(
      'unknown_command_ref',
      `Unknown Harness command reference: ${String(commandRef)}`,
      { command_ref: commandRef ?? null },
    );
  }

  const entry = config.entry_commands[commandRef];
  const implementation = catalog[commandRef];
  if (!implementation) {
    throw new HarnessPolicyError(
      'missing_command_implementation',
      `No reviewed implementation exists for command reference "${commandRef}"`,
      { command_ref: commandRef },
    );
  }
  if (displayCommand(implementation) !== entry.command) {
    throw new HarnessPolicyError(
      'command_implementation_drift',
      `Reviewed implementation for "${commandRef}" does not match the manifest`,
      { command_ref: commandRef },
    );
  }
  if (
    (entry.integrity_policy ?? null) !==
    (implementation.integrityPolicy ?? null)
  ) {
    throw new HarnessPolicyError(
      'command_integrity_policy_drift',
      `Reviewed integrity policy for "${commandRef}" does not match the manifest`,
      { command_ref: commandRef },
    );
  }

  const tool = config.tool_registry.find((item) => item.id === entry.tool_ref);
  if (!tool) {
    throw new HarnessPolicyError(
      'unknown_tool_ref',
      `Command "${commandRef}" references unknown tool "${entry.tool_ref}"`,
      { command_ref: commandRef, tool_id: entry.tool_ref },
    );
  }
  if (tool.status !== 'active') {
    throw new HarnessPolicyError(
      'planned_tool',
      `Command "${commandRef}" cannot use non-active tool "${tool.id}"`,
      { command_ref: commandRef, tool_id: tool.id },
    );
  }

  const environment = config.runtime_contract.environments[environmentId];
  if (!environment) {
    throw new HarnessPolicyError(
      'unknown_environment',
      `Unknown Harness environment: ${String(environmentId)}`,
      { command_ref: commandRef, environment_id: environmentId ?? null },
    );
  }
  if (environment.status !== 'active') {
    throw new HarnessPolicyError(
      'planned_environment',
      `Command "${commandRef}" cannot run in non-active environment "${environmentId}"`,
      { command_ref: commandRef, environment_id: environmentId },
    );
  }
  if (!entry.environments.includes(environmentId)) {
    throw new HarnessPolicyError(
      'unsupported_environment',
      `Command "${commandRef}" is not declared for environment "${environmentId}"`,
      { command_ref: commandRef, environment_id: environmentId },
    );
  }
  if (!environment.dependencies?.includes(tool.id)) {
    throw new HarnessPolicyError(
      'environment_tool_mismatch',
      `Environment "${environmentId}" does not declare tool "${tool.id}"`,
      {
        command_ref: commandRef,
        environment_id: environmentId,
        tool_id: tool.id,
      },
    );
  }

  return Object.freeze({
    commandRef,
    executable: implementation.executable,
    args: Object.freeze([...implementation.args]),
    toolId: tool.id,
    permissionId: entry.permission,
    environmentId,
    forwardEnv: Object.freeze([...(entry.forward_env ?? [])]),
    integrityPolicy: implementation.integrityPolicy ?? null,
    timeoutMs: tool.timeout_seconds * 1000,
  });
}

export function buildChildEnvironment({
  config,
  resolvedCommand,
  ambientEnvironment = process.env,
  internalEnvironment = {},
}) {
  const baseNames = config.runtime_contract.child_environment.base_allowlist;
  for (const name of baseNames) {
    if (
      isSecretLikeEnvName(name) ||
      !isAllowedChildEnvironmentName(name, 'base')
    ) {
      throw new HarnessPolicyError(
        'unsafe_environment_allowlist',
        `Base environment name is not in the implementation allowlist: ${name}`,
        { command_ref: resolvedCommand.commandRef, environment_name: name },
      );
    }
  }
  for (const name of resolvedCommand.forwardEnv) {
    if (
      isSecretLikeEnvName(name) ||
      !isAllowedChildEnvironmentName(name, 'forward')
    ) {
      throw new HarnessPolicyError(
        'unsafe_environment_allowlist',
        `Forwarded environment name is not in the implementation allowlist: ${name}`,
        { command_ref: resolvedCommand.commandRef, environment_name: name },
      );
    }
  }
  const allowedNames = new Set([...baseNames, ...resolvedCommand.forwardEnv]);

  const normalizedAllowedNames = new Set(
    [...allowedNames].map((name) => name.toUpperCase()),
  );
  const childEnvironment = {};
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (
      value !== undefined &&
      normalizedAllowedNames.has(name.toUpperCase()) &&
      !isSecretLikeEnvName(name)
    ) {
      childEnvironment[name] = String(value);
    }
  }

  if (
    !Object.keys(childEnvironment).some((name) => name.toUpperCase() === 'PATH')
  ) {
    throw new HarnessPolicyError(
      'missing_executable_path',
      'Harness child environment requires PATH/Path for executable lookup',
      { command_ref: resolvedCommand.commandRef },
    );
  }

  for (const [name, value] of Object.entries(internalEnvironment)) {
    if (!internalEnvironmentNames.has(name) || value === undefined) {
      throw new HarnessPolicyError(
        'unsafe_internal_environment',
        `Unsupported Harness internal environment name: ${name}`,
        { command_ref: resolvedCommand.commandRef, environment_name: name },
      );
    }
    childEnvironment[name] = String(value);
  }

  return Object.freeze(childEnvironment);
}

export function verifyCommandIntegrity({
  resolvedCommand,
  cwd = process.cwd(),
  git = execFileSync,
  gitExecutable,
}) {
  if (resolvedCommand.integrityPolicy === null) return;
  if (resolvedCommand.integrityPolicy !== 'committed_dependency_graph') {
    throw new HarnessPolicyError(
      'unknown_integrity_policy',
      `Unknown command integrity policy: ${resolvedCommand.integrityPolicy}`,
      { command_ref: resolvedCommand.commandRef },
    );
  }

  const trustedGitCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files\\Git\\bin\\git.exe',
          'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        ]
      : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  const trustedGitExecutable =
    gitExecutable ??
    trustedGitCandidates.find(
      (candidate) => isAbsolute(candidate) && existsSync(candidate),
    );
  if (!trustedGitExecutable) {
    throw new HarnessPolicyError(
      'integrity_check_unavailable',
      'Cannot locate Git at an implementation-approved absolute path',
      { command_ref: resolvedCommand.commandRef },
    );
  }

  const gitEnvironment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      isAllowedChildEnvironmentName(name, 'base') &&
      name.toUpperCase() !== 'PATH' &&
      !isSecretLikeEnvName(name)
    ) {
      gitEnvironment[name] = String(value);
    }
  }
  try {
    git(
      trustedGitExecutable,
      ['diff', '--quiet', 'HEAD', '--', 'package.json', 'package-lock.json'],
      {
        cwd,
        env: gitEnvironment,
        stdio: 'ignore',
        timeout: 60_000,
      },
    );
  } catch (error) {
    if (error?.status === 1) {
      throw new HarnessPolicyError(
        'dependency_graph_drift',
        'Locked dependency restoration requires package.json and package-lock.json to match HEAD',
        { command_ref: resolvedCommand.commandRef },
      );
    }
    throw new HarnessPolicyError(
      'integrity_check_unavailable',
      'Cannot prove the committed dependency graph before restoration',
      { command_ref: resolvedCommand.commandRef },
    );
  }
}

export function evaluateCommandPolicy({
  config,
  resolvedCommand,
  autonomyLevelId = config.autonomy_levels.default,
}) {
  const action = config.permission_model.actions[resolvedCommand.permissionId];
  if (!action) {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'unknown_permission',
      autonomyLevelId,
    });
  }

  const tool = config.tool_registry.find(
    (item) => item.id === resolvedCommand.toolId,
  );
  if (!tool?.permissions.includes(resolvedCommand.permissionId)) {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'tool_permission_mismatch',
      autonomyLevelId,
    });
  }

  if (action.effect === 'deny') {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'denied_permission',
      autonomyLevelId,
    });
  }
  if (action.effect === 'approval_required') {
    return Object.freeze({
      decision: 'approval_required',
      reasonCode: 'approval_artifact_unavailable',
      autonomyLevelId,
    });
  }

  const level = config.autonomy_levels.levels.find(
    (item) => item.id === autonomyLevelId,
  );
  if (!level) {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'unknown_autonomy_level',
      autonomyLevelId,
    });
  }
  if (level.status !== 'active') {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'planned_autonomy_level',
      autonomyLevelId,
    });
  }
  if (!level.permissions.includes(resolvedCommand.permissionId)) {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'autonomy_permission_mismatch',
      autonomyLevelId,
    });
  }
  if (!['allow', 'task_scoped'].includes(action.effect)) {
    return Object.freeze({
      decision: 'reject',
      reasonCode: 'unsupported_permission_effect',
      autonomyLevelId,
    });
  }

  return Object.freeze({
    decision: 'allow',
    reasonCode: action.effect === 'task_scoped' ? 'task_scoped_allow' : 'allow',
    autonomyLevelId,
  });
}

export function authorizeCommand(options) {
  const policy = evaluateCommandPolicy(options);
  if (policy.decision === 'allow') return policy;

  throw new HarnessPolicyError(
    policy.reasonCode,
    `Harness policy decision for "${options.resolvedCommand.commandRef}" is ${policy.decision}: ${policy.reasonCode}`,
    {
      command_ref: options.resolvedCommand.commandRef,
      permission_id: options.resolvedCommand.permissionId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
    },
  );
}

export function executeCommand({
  config,
  commandRef,
  environmentId,
  autonomyLevelId = config.autonomy_levels.default,
  ambientEnvironment = process.env,
  cwd = process.cwd(),
  stdio = 'inherit',
  catalog = commandCatalog,
  spawn = spawnSync,
  traceSink = createJsonLineTraceSink(),
  traceId = randomUUID(),
  routeId,
  contextSourceIds,
  clock = Date.now,
  integrityCheck = verifyCommandIntegrity,
}) {
  const traceBase = {
    schema_version: '0.2',
    trace_id: traceId,
    route_id: routeId,
    context_source_ids: contextSourceIds,
  };
  const trace = (event) =>
    emitHarnessTrace(traceSink, {
      ...traceBase,
      timestamp: new Date(clock()).toISOString(),
      ...event,
    });

  let resolvedCommand;
  try {
    resolvedCommand = resolveCommand({
      config,
      commandRef,
      environmentId,
      catalog,
    });
  } catch (error) {
    trace({
      event: 'policy_decision',
      command_ref:
        typeof commandRef === 'string' && commandRef in config.entry_commands
          ? commandRef
          : 'unregistered',
      autonomy_level: autonomyLevelId,
      decision: 'reject',
      status: 'blocked',
      failure_class:
        error instanceof HarnessPolicyError ? error.code : 'resolution_error',
    });
    throw error;
  }

  const policy = evaluateCommandPolicy({
    config,
    resolvedCommand,
    autonomyLevelId,
  });
  trace({
    event: 'policy_decision',
    command_ref: resolvedCommand.commandRef,
    tool_id: resolvedCommand.toolId,
    permission_id: resolvedCommand.permissionId,
    environment_id: resolvedCommand.environmentId,
    autonomy_level: policy.autonomyLevelId,
    decision: policy.decision,
    status: policy.decision === 'allow' ? 'succeeded' : 'blocked',
    failure_class: policy.decision === 'allow' ? undefined : policy.reasonCode,
  });
  if (policy.decision !== 'allow') {
    throw new HarnessPolicyError(
      policy.reasonCode,
      `Harness policy decision for "${resolvedCommand.commandRef}" is ${policy.decision}: ${policy.reasonCode}`,
      {
        command_ref: resolvedCommand.commandRef,
        permission_id: resolvedCommand.permissionId,
        autonomy_level: policy.autonomyLevelId,
        decision: policy.decision,
      },
    );
  }

  const startedAt = clock();
  try {
    integrityCheck({ resolvedCommand, cwd });
  } catch (error) {
    trace({
      event: 'command_failed',
      command_ref: resolvedCommand.commandRef,
      tool_id: resolvedCommand.toolId,
      permission_id: resolvedCommand.permissionId,
      environment_id: resolvedCommand.environmentId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
      status: 'failed',
      duration_ms: Math.max(0, clock() - startedAt),
      retry_count: 0,
      failure_class:
        error instanceof HarnessPolicyError ? error.code : 'integrity_error',
    });
    throw error;
  }
  trace({
    event: 'command_started',
    command_ref: resolvedCommand.commandRef,
    tool_id: resolvedCommand.toolId,
    permission_id: resolvedCommand.permissionId,
    environment_id: resolvedCommand.environmentId,
    autonomy_level: policy.autonomyLevelId,
    decision: policy.decision,
    status: 'started',
    retry_count: 0,
  });

  let childEnvironment;
  try {
    childEnvironment = buildChildEnvironment({
      config,
      resolvedCommand,
      ambientEnvironment,
      internalEnvironment: {
        HARNESS_AUTONOMY_LEVEL: policy.autonomyLevelId,
        HARNESS_COMMAND_REF: resolvedCommand.commandRef,
        HARNESS_ENVIRONMENT: resolvedCommand.environmentId,
        HARNESS_TRACE_ID: traceId,
      },
    });
  } catch (error) {
    trace({
      event: 'command_failed',
      command_ref: resolvedCommand.commandRef,
      tool_id: resolvedCommand.toolId,
      permission_id: resolvedCommand.permissionId,
      environment_id: resolvedCommand.environmentId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
      status: 'failed',
      duration_ms: Math.max(0, clock() - startedAt),
      retry_count: 0,
      failure_class:
        error instanceof HarnessPolicyError ? error.code : 'environment_error',
    });
    throw error;
  }

  let result;
  try {
    result = spawn(resolvedCommand.executable, resolvedCommand.args, {
      cwd,
      env: childEnvironment,
      shell: false,
      stdio,
      encoding: 'utf8',
      timeout: resolvedCommand.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    trace({
      event: 'command_failed',
      command_ref: resolvedCommand.commandRef,
      tool_id: resolvedCommand.toolId,
      permission_id: resolvedCommand.permissionId,
      environment_id: resolvedCommand.environmentId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
      status: 'failed',
      duration_ms: Math.max(0, clock() - startedAt),
      retry_count: 0,
      failure_class: 'spawn_error',
    });
    throw new HarnessPolicyError(
      'child_spawn_error',
      `Harness could not spawn command "${commandRef}"`,
      { command_ref: commandRef, failure_class: 'spawn_error' },
    );
  }

  if (result?.error?.code === 'ETIMEDOUT') {
    trace({
      event: 'command_failed',
      command_ref: resolvedCommand.commandRef,
      tool_id: resolvedCommand.toolId,
      permission_id: resolvedCommand.permissionId,
      environment_id: resolvedCommand.environmentId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
      status: 'failed',
      duration_ms: Math.max(0, clock() - startedAt),
      retry_count: 0,
      exit_code: result.status ?? null,
      failure_class: 'timeout',
    });
    throw new HarnessPolicyError(
      'child_timeout',
      `Harness command "${commandRef}" exceeded its timeout`,
      { command_ref: commandRef, failure_class: 'timeout' },
    );
  }
  if (result?.error) {
    trace({
      event: 'command_failed',
      command_ref: resolvedCommand.commandRef,
      tool_id: resolvedCommand.toolId,
      permission_id: resolvedCommand.permissionId,
      environment_id: resolvedCommand.environmentId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
      status: 'failed',
      duration_ms: Math.max(0, clock() - startedAt),
      retry_count: 0,
      exit_code: result.status ?? null,
      failure_class: 'spawn_error',
    });
    throw new HarnessPolicyError(
      'child_spawn_error',
      `Harness could not execute command "${commandRef}"`,
      { command_ref: commandRef, failure_class: 'spawn_error' },
    );
  }
  if (result?.status !== 0) {
    trace({
      event: 'command_failed',
      command_ref: resolvedCommand.commandRef,
      tool_id: resolvedCommand.toolId,
      permission_id: resolvedCommand.permissionId,
      environment_id: resolvedCommand.environmentId,
      autonomy_level: policy.autonomyLevelId,
      decision: policy.decision,
      status: 'failed',
      duration_ms: Math.max(0, clock() - startedAt),
      retry_count: 0,
      exit_code: result?.status ?? null,
      failure_class: 'nonzero_exit',
    });
    throw new HarnessPolicyError(
      'child_nonzero_exit',
      `Harness command "${commandRef}" exited with status ${String(result?.status)}`,
      {
        command_ref: commandRef,
        failure_class: 'nonzero_exit',
        exit_code: result?.status ?? null,
        signal: result?.signal ?? null,
      },
    );
  }

  const durationMs = Math.max(0, clock() - startedAt);
  trace({
    event: 'command_completed',
    command_ref: resolvedCommand.commandRef,
    tool_id: resolvedCommand.toolId,
    permission_id: resolvedCommand.permissionId,
    environment_id: resolvedCommand.environmentId,
    autonomy_level: policy.autonomyLevelId,
    decision: policy.decision,
    status: 'succeeded',
    duration_ms: durationMs,
    retry_count: 0,
    exit_code: result.status,
  });

  return Object.freeze({
    commandRef: resolvedCommand.commandRef,
    toolId: resolvedCommand.toolId,
    permissionId: resolvedCommand.permissionId,
    autonomyLevelId: policy.autonomyLevelId,
    environmentId: resolvedCommand.environmentId,
    traceId,
    durationMs,
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}
