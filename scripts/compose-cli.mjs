import { spawnSync } from 'node:child_process';

const candidates = [
  { executable: 'docker', prefix: ['compose'], label: 'docker compose' },
  { executable: 'docker-compose', prefix: [], label: 'docker-compose' },
];

function composeMajorVersion(output) {
  const match = output.match(/\bv?(\d+)\.\d+(?:\.\d+)?\b/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function resolveComposeCli(run = spawnSync) {
  for (const candidate of candidates) {
    const result = run(candidate.executable, [...candidate.prefix, 'version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const versionOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    if (
      !result.error &&
      result.status === 0 &&
      composeMajorVersion(versionOutput) >= 2
    ) {
      return candidate;
    }
  }

  throw new Error(
    'Docker Compose v2 or newer is unavailable. Install or upgrade Docker Compose, then retry.',
  );
}

export function composeArguments(composeCli, args) {
  return [...composeCli.prefix, ...args];
}
