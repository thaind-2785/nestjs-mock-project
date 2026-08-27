import { randomUUID } from 'node:crypto';
import { loadHarness, validateHarness } from './harness-check.mjs';
import {
  createJsonLineTraceSink,
  emitHarnessTrace,
  executeCommand,
  HarnessPolicyError,
  selectContext,
} from './harness-runtime.mjs';

const checks = [
  'harness_check',
  'harness_test',
  'harness_eval',
  'format_check',
  'lint_check',
  'unit_test',
  'integration_test',
  'e2e_test',
  'build',
];
const traceId = randomUUID();
const traceSink = createJsonLineTraceSink();
let verificationContextSourceIds;

function emitVerificationCompleted(status, failureClass, exitCode) {
  emitHarnessTrace(traceSink, {
    schema_version: '0.2',
    timestamp: new Date().toISOString(),
    trace_id: traceId,
    event: 'verification_completed',
    route_id: 'repository_verification',
    context_source_ids: verificationContextSourceIds,
    status,
    retry_count: 0,
    exit_code: exitCode,
    failure_class: failureClass,
  });
}

const loaded = loadHarness();
const validationErrors = validateHarness(
  loaded.config,
  loaded.packageJson,
  loaded.rootDirectory,
  loaded.schema,
);
if (validationErrors.length > 0) {
  emitVerificationCompleted('failed', 'invalid_harness_config', 1);
  console.error('Harness validation failed before managed execution:');
  for (const error of validationErrors) console.error(`- ${error}`);
  process.exit(1);
}
const { config } = loaded;
const context = selectContext({
  config,
  taskClasses: ['harness', 'test'],
});
verificationContextSourceIds = context.sourceIds;
const environmentId = process.env.CI ? 'ci' : 'local';

for (const commandRef of checks) {
  try {
    executeCommand({
      config,
      commandRef,
      environmentId,
      ambientEnvironment: process.env,
      traceSink,
      traceId,
      routeId: 'repository_verification',
      contextSourceIds: context.sourceIds,
    });
  } catch (error) {
    const failureClass =
      error instanceof HarnessPolicyError ? error.code : 'unexpected_error';
    const exitCode = error?.details?.exit_code ?? 1;
    try {
      emitVerificationCompleted('failed', failureClass, exitCode);
    } catch {
      // The original failure remains authoritative when the trace sink itself fails.
    }
    console.error(`[harness] repository verification stopped: ${failureClass}`);
    process.exit(exitCode);
  }
}

emitVerificationCompleted('succeeded', undefined, 0);
