import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadRepositoryEnvironment(): void {
  const environmentFile = resolve(process.cwd(), '.env');
  if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
}
