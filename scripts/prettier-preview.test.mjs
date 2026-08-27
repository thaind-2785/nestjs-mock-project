import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as prettier from 'prettier';

for (const path of [
  'scripts/harness-ci-policy.mjs',
  'scripts/harness-v02-closure.test.mjs',
]) {
  test(`prettier preview ${path}`, async () => {
    const source = readFileSync(path, 'utf8');
    const formatted = await prettier.format(source, {
      parser: 'babel',
      singleQuote: true,
      trailingComma: 'all',
    });
    console.log(`PRETTIER_BASE64:${path}:${Buffer.from(formatted).toString('base64')}`);
  });
}
