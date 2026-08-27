import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '..');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function duplicateValues(values) {
  return [
    ...new Set(
      values.filter((value, index) => values.indexOf(value) !== index),
    ),
  ];
}

function collectionIds(items) {
  return Array.isArray(items)
    ? items.filter(isRecord).map((item) => item.id)
    : [];
}

function isInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..')
  );
}

export function validateRepositoryPath(
  rootDirectory,
  declaredPath,
  expectedKind = 'any',
) {
  if (typeof declaredPath !== 'string' || declaredPath.trim() === '') {
    return 'must be a non-empty repository-relative path';
  }
  if (isAbsolute(declaredPath)) {
    return 'must be repository-relative, not absolute';
  }

  const resolvedRoot = realpathSync(rootDirectory);
  const resolvedCandidate = resolve(resolvedRoot, declaredPath);
  if (!isInside(resolvedRoot, resolvedCandidate)) {
    return 'must not escape the repository';
  }
  if (!existsSync(resolvedCandidate)) {
    return `path does not exist: ${declaredPath}`;
  }

  const realCandidate = realpathSync(resolvedCandidate);
  if (!isInside(resolvedRoot, realCandidate)) {
    return 'symlink target must remain inside the repository';
  }

  const stat = lstatSync(realCandidate);
  if (expectedKind === 'file' && !stat.isFile()) return 'must reference a file';
  if (expectedKind === 'directory' && !stat.isDirectory()) {
    return 'must reference a directory';
  }
  return null;
}

function formatSchemaPath(error) {
  const path = error.instancePath
    ? error.instancePath.slice(1).replaceAll('/', '.')
    : '.harness/manifest.yaml';
  return `${path}: ${error.message}`;
}

function parseMajor(version) {
  const match = /^(?:>=)?(\d+)/.exec(String(version));
  return match ? Number(match[1]) : null;
}

function getNpmMajor() {
  const userAgent = process.env.npm_config_user_agent ?? '';
  const match = /(?:^|\s)npm\/(\d+)/.exec(userAgent);
  return match ? Number(match[1]) : null;
}

export function validateCiWorkflow(workflow, config) {
  const errors = [];
  const addError = (path, message) => errors.push(`${path}: ${message}`);
  const triggers = workflow?.on;
  if (!isRecord(triggers) || !('pull_request' in triggers)) {
    addError(
      'runtime_contract.ci_workflow.on',
      'must run for pull_request events',
    );
  }
  const pushBranches = triggers?.push?.branches;
  if (
    !Array.isArray(pushBranches) ||
    pushBranches.length !== 1 ||
    pushBranches[0] !== 'main'
  ) {
    addError(
      'runtime_contract.ci_workflow.on.push.branches',
      'must contain only main',
    );
  }

  const permissions = workflow?.permissions;
  if (
    !isRecord(permissions) ||
    permissions.contents !== 'read' ||
    Object.keys(permissions).some((key) => key !== 'contents')
  ) {
    addError(
      'runtime_contract.ci_workflow.permissions',
      'must grant only contents: read',
    );
  }

  const job = workflow?.jobs?.verify;
  const githubTool = config.tool_registry.find(
    (tool) => tool.id === 'github_actions',
  );
  const maxTimeoutMinutes = githubTool?.timeout_seconds
    ? githubTool.timeout_seconds / 60
    : 0;
  if (
    !Number.isInteger(job?.['timeout-minutes']) ||
    job['timeout-minutes'] < 1 ||
    job['timeout-minutes'] > maxTimeoutMinutes
  ) {
    addError(
      'runtime_contract.ci_workflow.jobs.verify.timeout-minutes',
      `must be positive and no greater than ${maxTimeoutMinutes}`,
    );
  }

  const steps = job?.steps ?? [];
  const setupNode = steps.find((step) =>
    String(step?.uses ?? '').startsWith('actions/setup-node@'),
  );
  if (
    setupNode?.with?.['node-version-file'] !==
    config.runtime_contract.version_file
  ) {
    addError(
      'runtime_contract.ci_workflow',
      `must configure setup-node with ${config.runtime_contract.version_file}`,
    );
  }
  if (
    !steps.some((step) => step?.run === config.entry_commands.verify.command)
  ) {
    addError(
      'runtime_contract.ci_workflow',
      `must run "${config.entry_commands.verify.command}"`,
    );
  }
  if (
    !steps.some((step) => step?.run === config.entry_commands.bootstrap.command)
  ) {
    addError(
      'runtime_contract.ci_workflow',
      `must run locked install "${config.entry_commands.bootstrap.command}"`,
    );
  }
  if (job?.name !== config.pr_lifecycle.merge_enforcement.required_check) {
    addError(
      'pr_lifecycle.merge_enforcement.required_check',
      'must match the GitHub Actions verify job name',
    );
  }
  for (const [index, step] of steps.entries()) {
    if (
      typeof step?.uses === 'string' &&
      !/^[^@]+@[0-9a-f]{40}$/.test(step.uses)
    ) {
      addError(
        `runtime_contract.ci_workflow.steps[${index}].uses`,
        'must pin third-party actions to a 40-character commit SHA',
      );
    }
  }

  return errors;
}

export function loadHarness(rootDirectory = defaultRoot) {
  const manifestPath = resolve(rootDirectory, '.harness/manifest.yaml');
  const packagePath = resolve(rootDirectory, 'package.json');
  const schemaPath = resolve(rootDirectory, '.harness/schema.json');

  return {
    config: parse(readFileSync(manifestPath, 'utf8')),
    packageJson: JSON.parse(readFileSync(packagePath, 'utf8')),
    schema: JSON.parse(readFileSync(schemaPath, 'utf8')),
    rootDirectory,
  };
}

export function validateHarness(
  config,
  packageJson,
  rootDirectory = defaultRoot,
  schema = loadHarness(rootDirectory).schema,
) {
  const errors = [];
  const addError = (path, message) => errors.push(`${path}: ${message}`);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validateSchema = ajv.compile(schema);

  if (!validateSchema(config)) {
    return validateSchema.errors.map(formatSchemaPath);
  }

  const commands = config.entry_commands;
  const actions = config.permission_model.actions;
  const tools = config.tool_registry;
  const toolIds = collectionIds(tools);
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const environments = config.runtime_contract.environments;
  const packageScripts = isRecord(packageJson?.scripts)
    ? packageJson.scripts
    : {};

  const pathChecks = [
    ['project.source_of_truth', config.project.source_of_truth, 'file'],
    ['workflow.state_record', config.workflow.state_record, 'directory'],
    ...config.context_strategy.sources.map((source, index) => [
      `context_strategy.sources[${index}].path`,
      source.path,
      'file',
    ]),
    ...config.skill_boundaries.skills.map((skill, index) => [
      `skill_boundaries.skills[${index}].path`,
      skill.path,
      'file',
    ]),
    ...config.memory_model.records.map((record, index) => [
      `memory_model.records[${index}].path`,
      record.path,
      'any',
    ]),
    [
      'runtime_contract.version_file',
      config.runtime_contract.version_file,
      'file',
    ],
    ['runtime_contract.lockfile', config.runtime_contract.lockfile, 'file'],
    [
      'runtime_contract.ci_workflow',
      config.runtime_contract.ci_workflow,
      'file',
    ],
  ];

  for (const [index, tool] of tools.entries()) {
    if (tool.implementation_ref) {
      pathChecks.push([
        `tool_registry[${index}].implementation_ref`,
        tool.implementation_ref,
        'any',
      ]);
    }
  }
  for (const [index, sink] of config.observability.sinks.entries()) {
    if (sink.implementation_ref) {
      pathChecks.push([
        `observability.sinks[${index}].implementation_ref`,
        sink.implementation_ref,
        'any',
      ]);
    }
    if (sink.status === 'active' && !sink.implementation_ref) {
      addError(
        `observability.sinks[${index}].implementation_ref`,
        'is required for an active sink',
      );
    }
  }
  for (const [index, event] of config.observability.harness_events.entries()) {
    if (event.status === 'active') {
      pathChecks.push([
        `observability.harness_events[${index}].emitter`,
        event.emitter,
        'file',
      ]);
    }
  }
  for (const [path, declaredPath, expectedKind] of pathChecks) {
    const pathError = validateRepositoryPath(
      rootDirectory,
      declaredPath,
      expectedKind,
    );
    if (pathError) addError(path, pathError);
  }

  for (const [id, command] of Object.entries(commands)) {
    if (command.npm_script !== undefined) {
      if (!(command.npm_script in packageScripts)) {
        addError(
          `entry_commands.${id}.npm_script`,
          `references missing package script "${command.npm_script}"`,
        );
      }
      if (command.command !== `npm run ${command.npm_script}`) {
        addError(
          `entry_commands.${id}.command`,
          `must equal "npm run ${command.npm_script}"`,
        );
      }
    } else if (id !== 'bootstrap' || command.command !== 'npm ci') {
      addError(
        `entry_commands.${id}.command`,
        'direct commands are denied except bootstrap "npm ci"',
      );
    }

    if (!(command.permission in actions)) {
      addError(
        `entry_commands.${id}.permission`,
        `references unknown action "${command.permission}"`,
      );
    }
    const tool = toolsById.get(command.tool_ref);
    if (!tool) {
      addError(
        `entry_commands.${id}.tool_ref`,
        `references unknown tool "${command.tool_ref}"`,
      );
    } else {
      if (tool.status !== 'active') {
        addError(
          `entry_commands.${id}.tool_ref`,
          `references non-active tool "${command.tool_ref}"`,
        );
      }
      if (!tool.permissions.includes(command.permission)) {
        addError(
          `entry_commands.${id}.permission`,
          `is not granted to tool "${command.tool_ref}"`,
        );
      }
    }
    for (const environment of command.environments) {
      if (!(environment in environments)) {
        addError(
          `entry_commands.${id}.environments`,
          `references unknown environment "${environment}"`,
        );
      } else if (environments[environment].status !== 'active') {
        addError(
          `entry_commands.${id}.environments`,
          `references non-active environment "${environment}"`,
        );
      }
    }
  }

  for (const duplicate of duplicateValues(toolIds)) {
    addError('tool_registry', `duplicate tool "${duplicate}"`);
  }
  for (const [index, tool] of tools.entries()) {
    for (const permission of tool.permissions) {
      if (!(permission in actions)) {
        addError(
          `tool_registry[${index}].permissions`,
          `references unknown action "${permission}"`,
        );
      }
    }
    if (tool.status === 'active' && !tool.implementation_ref) {
      addError(
        `tool_registry[${index}].implementation_ref`,
        'is required for an active tool',
      );
    }
  }

  const stateIds = collectionIds(config.workflow.states);
  for (const duplicate of duplicateValues(stateIds)) {
    addError('workflow.states', `duplicate state "${duplicate}"`);
  }
  if (!stateIds.includes(config.workflow.initial_state)) {
    addError('workflow.initial_state', 'must reference a declared state');
  }
  for (const terminal of config.workflow.terminal_states) {
    if (!stateIds.includes(terminal)) {
      addError('workflow.terminal_states', `unknown state "${terminal}"`);
    }
  }
  for (const [index, transition] of config.workflow.transitions.entries()) {
    if (!stateIds.includes(transition.from)) {
      addError(`workflow.transitions[${index}].from`, 'unknown workflow state');
    }
    if (!stateIds.includes(transition.to)) {
      addError(`workflow.transitions[${index}].to`, 'unknown workflow state');
    }
  }

  const activeCommandReferences = [];
  for (const [index, hook] of config.hook_lifecycle.hooks.entries()) {
    if (!(hook.command_ref in commands)) {
      addError(
        `hook_lifecycle.hooks[${index}].command_ref`,
        `references unknown entry command "${hook.command_ref}"`,
      );
    } else if (hook.status === 'active') {
      activeCommandReferences.push(hook.command_ref);
    }
  }
  for (const [
    index,
    evaluation,
  ] of config.evaluation_strategy.evaluations.entries()) {
    if (!(evaluation.command_ref in commands)) {
      addError(
        `evaluation_strategy.evaluations[${index}].command_ref`,
        `references unknown entry command "${evaluation.command_ref}"`,
      );
    }
  }
  for (const commandRef of config.pr_lifecycle.required_commands) {
    if (!(commandRef in commands)) {
      addError(
        'pr_lifecycle.required_commands',
        `references unknown entry command "${commandRef}"`,
      );
    }
  }
  for (const commandRef of activeCommandReferences) {
    const tool = toolsById.get(commands[commandRef]?.tool_ref);
    if (tool?.status === 'planned') {
      addError(
        'hook_lifecycle.hooks',
        `active hook resolves to planned tool "${tool.id}"`,
      );
    }
  }

  for (const section of [
    ['context_strategy.sources', config.context_strategy.sources],
    ['skill_boundaries.skills', config.skill_boundaries.skills],
    ['memory_model.records', config.memory_model.records],
    ['evaluation_strategy.evaluations', config.evaluation_strategy.evaluations],
    ['hook_lifecycle.hooks', config.hook_lifecycle.hooks],
    ['observability.harness_events', config.observability.harness_events],
    ['observability.sinks', config.observability.sinks],
  ]) {
    for (const duplicate of duplicateValues(collectionIds(section[1]))) {
      addError(section[0], `duplicate id "${duplicate}"`);
    }
  }

  const levels = config.autonomy_levels.levels;
  const levelIds = collectionIds(levels);
  for (const duplicate of duplicateValues(levelIds)) {
    addError('autonomy_levels.levels', `duplicate level "${duplicate}"`);
  }
  const defaultLevel = levels.find(
    (level) => level.id === config.autonomy_levels.default,
  );
  if (!defaultLevel) {
    addError('autonomy_levels.default', 'must reference a declared level');
  } else if (defaultLevel.status !== 'active') {
    addError('autonomy_levels.default', 'must reference an active level');
  }
  for (const [index, level] of levels.entries()) {
    for (const permission of level.permissions) {
      if (!(permission in actions)) {
        addError(
          `autonomy_levels.levels[${index}].permissions`,
          `references unknown action "${permission}"`,
        );
      }
    }
  }

  for (const [environmentId, environment] of Object.entries(environments)) {
    for (const dependency of environment.dependencies ?? []) {
      const tool = toolsById.get(dependency);
      if (!tool) {
        addError(
          `runtime_contract.environments.${environmentId}.dependencies`,
          `references unknown tool "${dependency}"`,
        );
      } else if (environment.status === 'active' && tool.status !== 'active') {
        addError(
          `runtime_contract.environments.${environmentId}.dependencies`,
          `active environment references planned tool "${dependency}"`,
        );
      }
    }
  }

  const runtime = config.runtime_contract;
  const versionPath = resolve(rootDirectory, runtime.version_file);
  if (existsSync(versionPath)) {
    const declaredMajor = readFileSync(versionPath, 'utf8').trim();
    if (declaredMajor !== String(runtime.node_major)) {
      addError(
        'runtime_contract.node_major',
        `does not match ${runtime.version_file} (${declaredMajor})`,
      );
    }
  }
  if (packageJson?.engines?.node !== runtime.node_engine) {
    addError(
      'runtime_contract.node_engine',
      'must match package.json engines.node',
    );
  }
  if (packageJson?.engines?.npm !== runtime.npm_engine) {
    addError(
      'runtime_contract.npm_engine',
      'must match package.json engines.npm',
    );
  }
  if (parseMajor(process.versions.node) !== runtime.node_major) {
    addError(
      'runtime_contract.node_major',
      `current Node ${process.versions.node} does not satisfy major ${runtime.node_major}`,
    );
  }
  const npmMajor = getNpmMajor();
  if (npmMajor === null) {
    addError(
      'runtime_contract.npm_minimum_major',
      'cannot detect npm version; run the validator through npm',
    );
  } else if (npmMajor < runtime.npm_minimum_major) {
    addError(
      'runtime_contract.npm_minimum_major',
      `current npm ${npmMajor} is below minimum ${runtime.npm_minimum_major}`,
    );
  }
  if (!(runtime.install_command_ref in commands)) {
    addError(
      'runtime_contract.install_command_ref',
      `references unknown entry command "${runtime.install_command_ref}"`,
    );
  }

  const workflowPath = resolve(rootDirectory, runtime.ci_workflow);
  if (existsSync(workflowPath)) {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    errors.push(...validateCiWorkflow(workflow, config));
  }

  return errors;
}

function runCli() {
  try {
    const { config, packageJson, rootDirectory, schema } = loadHarness();
    const errors = validateHarness(config, packageJson, rootDirectory, schema);

    if (errors.length > 0) {
      console.error('Harness validation failed:');
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `Harness v${config.schema_version} valid: ${Object.keys(config.entry_commands).length} entry commands, ${config.workflow.states.length} workflow states, ${config.tool_registry.length} tools.`,
    );
  } catch (error) {
    console.error(`Harness validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
