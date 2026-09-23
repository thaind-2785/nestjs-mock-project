import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Loads `.env` into `process.env` without overriding what the caller already set.
 *
 * Parsed and assigned here rather than through `process.loadEnvFile`, which writes to
 * the real process environment. That is the same object in production and a different
 * one under jest: each test file is handed a copy of `process.env`, so the write landed
 * somewhere the suite could not see and this function was a no-op in every test.
 *
 * Nothing failed visibly, which is what made it expensive. Suites fell back to the
 * schema's defaults - `127.0.0.1:3306` for MySQL - and passed anyway on any machine
 * where the documented `MYSQL_PORT=13306 npm run verify` supplied the value through the
 * shell instead. Run without that prefix, a suite would connect to whatever else
 * answered on 3306 and report a message blaming the operator's compose stack. Local gate
 * evidence was therefore order-dependent and could come from a database nobody started.
 *
 * Existing values win, so an explicit environment variable still overrides the file.
 */
export function loadRepositoryEnvironment(): void {
  const environmentFile = resolve(process.cwd(), '.env');
  if (!existsSync(environmentFile)) return;
  const parsed = parseEnv(readFileSync(environmentFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
