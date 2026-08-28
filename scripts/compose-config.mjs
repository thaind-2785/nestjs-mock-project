import { spawnSync } from 'node:child_process';
import { composeArguments, resolveComposeCli } from './compose-cli.mjs';

let composeCli;
try {
  composeCli = resolveComposeCli();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = spawnSync(
  composeCli.executable,
  composeArguments(composeCli, ['config', '--quiet']),
  { cwd: process.cwd(), stdio: 'inherit' },
);

if (result.error || result.status !== 0) {
  console.error(
    'Compose configuration is invalid. Review compose.yaml and .env.',
  );
  process.exit(result.status ?? 1);
}
