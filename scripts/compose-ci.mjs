import { spawnSync } from 'node:child_process';
import { composeArguments, resolveComposeCli } from './compose-cli.mjs';
import { ciReadinessServices } from './compose-ci-policy.mjs';

let composeCli;
try {
  composeCli = resolveComposeCli();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = spawnSync(
  composeCli.executable,
  composeArguments(composeCli, [
    'up',
    '--detach',
    '--wait',
    '--wait-timeout',
    '180',
    ...ciReadinessServices,
  ]),
  { cwd: process.cwd(), stdio: 'inherit' },
);

if (result.error || result.status !== 0) {
  console.error(
    'Readiness dependencies could not start. Check Docker, then rerun npm run compose:ci.',
  );
  process.exit(result.status ?? 1);
}
