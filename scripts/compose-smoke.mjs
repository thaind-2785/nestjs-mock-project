import { spawnSync } from 'node:child_process';
import { composeArguments, resolveComposeCli } from './compose-cli.mjs';
import { createPersistenceProbe } from './compose-smoke-policy.mjs';

const services = ['mysql', 'redis', 'minio', 'mailpit'];

function runCommand(executable, args, { capture = false, failureHint } = {}) {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });

  if (result.error || result.status !== 0) {
    if (capture) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      if (output) console.error(output);
    }
    if (failureHint) console.error(failureHint);
    process.exit(result.status ?? 1);
  }

  return capture ? result.stdout.trim() : '';
}

let composeCli;
try {
  composeCli = resolveComposeCli();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function runDocker(args, options) {
  return runCommand('docker', args, options);
}

function runCompose(args, options) {
  return runCommand(
    composeCli.executable,
    composeArguments(composeCli, args),
    options,
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealthy(service, timeoutMilliseconds = 120_000) {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    const containerId = runCompose(['ps', '--quiet', service], {
      capture: true,
    });
    if (containerId) {
      const status = runDocker(
        ['inspect', '--format', '{{.State.Health.Status}}', containerId],
        { capture: true },
      );
      if (status === 'healthy') return;
      if (status === 'unhealthy') {
        console.error(`Compose service "${service}" became unhealthy.`);
        process.exit(1);
      }
    }
    await wait(1_000);
  }

  console.error(
    `Timed out waiting for Compose service "${service}" to be healthy.`,
  );
  process.exit(1);
}

runDocker(['info', '--format', '{{.ServerVersion}}'], {
  capture: true,
  failureHint:
    'The Docker daemon is unavailable. Start Docker Desktop or Colima, then rerun npm run compose:smoke.',
});
runCompose(['config', '--quiet'], {
  failureHint:
    'Compose configuration is invalid. Review compose.yaml and .env.',
});
runCompose(['up', '--detach', '--wait', '--wait-timeout', '180', ...services]);

for (const service of services) await waitForHealthy(service);

const { key: persistenceKey, value: persistenceValue } =
  createPersistenceProbe();
runCompose(
  [
    'exec',
    '--no-TTY',
    'redis',
    'redis-cli',
    'SET',
    persistenceKey,
    persistenceValue,
  ],
  { capture: true },
);
runCompose(['restart', 'redis']);
await waitForHealthy('redis');

const restoredValue = runCompose(
  ['exec', '--no-TTY', 'redis', 'redis-cli', 'GET', persistenceKey],
  { capture: true },
);
runCompose(['exec', '--no-TTY', 'redis', 'redis-cli', 'DEL', persistenceKey], {
  capture: true,
});

if (restoredValue !== persistenceValue) {
  console.error('Redis persistence probe did not survive a service restart.');
  process.exit(1);
}

console.log(
  `compose_smoke_passed services=${services.length} persistence=redis`,
);
