import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRepositoryEnvironment } from './environment-file';

/**
 * The point of this suite is that it runs under jest.
 *
 * The previous implementation called `process.loadEnvFile`, which writes to the real
 * process environment while jest hands each test file a copy - so it loaded nothing the
 * caller could see, and every suite silently fell back to the schema's defaults. It
 * failed nowhere, because the documented gate command supplies the one value that
 * mattered through the shell. A test that exercises the function anywhere other than
 * inside jest would have kept passing.
 */
describe('loadRepositoryEnvironment', () => {
  let directory: string;
  let previousCwd: string;
  const owned = ['RETENTION_SPEC_ONLY', 'RETENTION_SPEC_PRESET'];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'env-file-'));
    previousCwd = process.cwd();
    process.chdir(directory);
    for (const key of owned) delete process.env[key];
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(directory, { recursive: true, force: true });
    for (const key of owned) delete process.env[key];
  });

  it('makes a file-only variable visible to the caller that loaded it', () => {
    writeFileSync(join(directory, '.env'), 'RETENTION_SPEC_ONLY=from-file\n');

    loadRepositoryEnvironment();

    expect(process.env.RETENTION_SPEC_ONLY).toBe('from-file');
  });

  it('leaves an explicit variable alone', () => {
    // The gate is documented as `MYSQL_PORT=13306 npm run verify`, so the shell has to
    // keep winning over the file.
    process.env.RETENTION_SPEC_PRESET = 'from-shell';
    writeFileSync(join(directory, '.env'), 'RETENTION_SPEC_PRESET=from-file\n');

    loadRepositoryEnvironment();

    expect(process.env.RETENTION_SPEC_PRESET).toBe('from-shell');
  });

  it('does nothing when there is no file', () => {
    expect(() => loadRepositoryEnvironment()).not.toThrow();
    expect(process.env.RETENTION_SPEC_ONLY).toBeUndefined();
  });
});
