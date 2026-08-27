import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const checkTimeoutMs = 900_000;

const checks = [
  ['Harness manifest', npmCommand, ['run', 'harness:check']],
  [
    'Formatting',
    npxCommand,
    [
      'prettier',
      '--check',
      'src/**/*.ts',
      'test/**/*.ts',
      'scripts/**/*.mjs',
      'docs/**/*.md',
      '.agents/skills/**/*.md',
      '.github/**/*.yml',
      '.harness/manifest.yaml',
      '.harness/schema.json',
      '*.md',
    ],
  ],
  [
    'Lint',
    npxCommand,
    ['eslint', '--max-warnings=0', '{src,apps,libs,test}/**/*.ts'],
  ],
  ['Unit tests', npmCommand, ['test', '--', '--runInBand']],
  ['Harness tests', npmCommand, ['run', 'test:harness']],
  ['Integration tests', npmCommand, ['run', 'test:integration']],
  ['E2E tests', npmCommand, ['run', 'test:e2e', '--', '--runInBand']],
  ['Build', npmCommand, ['run', 'build']],
];

for (const [name, command, args] of checks) {
  console.log(`\n[harness] command_started name=${JSON.stringify(name)}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
    timeout: checkTimeoutMs,
    killSignal: 'SIGTERM',
  });

  if (result.error) {
    console.error(
      `[harness] command_failed name=${JSON.stringify(name)} reason=${JSON.stringify(result.error.message)}`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `[harness] command_failed name=${JSON.stringify(name)} exit_code=${result.status}`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log('\n[harness] verification_completed status=passed');
