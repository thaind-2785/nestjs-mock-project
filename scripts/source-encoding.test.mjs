import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * Tab, newline, and carriage return are the only control characters a text source is
 * allowed to contain. Everything else below 0x20, plus DEL, is a raw control byte.
 */
const allowed = new Set([0x09, 0x0a, 0x0d]);

const reviewableExtensions = /\.(ts|mts|cts|tsx|mjs|cjs|js|json|md|yaml|yml)$/;

function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.length > 0 && reviewableExtensions.test(path));
}

function offendingBytes(path) {
  const bytes = readFileSync(path);
  const found = new Set();
  for (const byte of bytes) {
    if (byte === 0x7f || (byte < 0x20 && !allowed.has(byte))) found.add(byte);
  }
  return [...found]
    .sort((a, b) => a - b)
    .map((byte) => `0x${byte.toString(16)}`);
}

// Git marks a file containing a NUL byte as binary, and then `git show`, `git blame`,
// `git add -p`, and every pull-request diff refuse to display it. A reviewable source
// file that arrives as `Bin 0 -> 3461 bytes` cannot be reviewed at all, which in this
// repository means it cannot be merged honestly. Writing the same characters as
// `\uXXXX` escapes costs nothing and keeps the file readable.
test('reviewable sources contain no raw control bytes', () => {
  const offenders = trackedTextFiles()
    .map((path) => ({ path, bytes: offendingBytes(path) }))
    .filter((entry) => entry.bytes.length > 0)
    .map((entry) => `${entry.path}: ${entry.bytes.join(', ')}`);

  assert.deepEqual(
    offenders,
    [],
    `Raw control bytes make a file binary to git and unreviewable in a diff. Write them as \\uXXXX escapes instead:\n${offenders.join('\n')}`,
  );
});
