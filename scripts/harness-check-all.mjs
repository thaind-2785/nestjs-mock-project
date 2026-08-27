import { loadHarness, validateHarness } from './harness-check.mjs';
import { runCiPolicyCheck } from './harness-ci-policy.mjs';

try {
  const loaded = loadHarness();
  const errors = [
    ...validateHarness(
      loaded.config,
      loaded.packageJson,
      loaded.rootDirectory,
      loaded.schema,
    ),
    ...runCiPolicyCheck(loaded.rootDirectory),
  ];

  if (errors.length > 0) {
    console.error('Harness validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Harness v${loaded.config.schema_version} valid: ${Object.keys(loaded.config.entry_commands).length} entry commands, ${loaded.config.workflow.states.length} workflow states, ${loaded.config.tool_registry.length} tools.`,
    );
  }
} catch (error) {
  console.error(`Harness validation failed: ${error.message}`);
  process.exitCode = 1;
}
