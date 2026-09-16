import assert from 'node:assert/strict';
import test from 'node:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { implementationDeclarationRestrictions } from '../eslint.config.mjs';

function verify(source) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    source,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: {
          'no-restricted-syntax': implementationDeclarationRestrictions,
        },
      },
    ],
    { filename: 'fixture.service.ts' },
  );
}

test('rejects exported contracts and constants in implementation files', () => {
  const messages = verify(`
    export interface SharedContract { id: string }
    export type SharedResult = 'ok';
    export const sharedLimit = 10;
    export enum SharedStatus { Ok = 'ok' }
    export class AllowedService {}
  `);

  assert.deepEqual(
    messages.map((message) => message.message),
    [
      'Move exported interfaces to a concern-specific contract or *.types.ts file.',
      'Move exported types to a concern-specific contract or *.types.ts file.',
      'Move exported constants to a concern-specific *.constants.ts or token file.',
      'Move exported enums to a concern-specific *.enums.ts or contract file.',
    ],
  );
});

test('allows executable exports and file-local implementation details', () => {
  const messages = verify(`
    interface LocalProjection { id: string }
    type LocalResult = 'ok';
    const localLimit = 10;
    enum LocalStatus { Ok = 'ok' }
    export class AllowedRepository {}
    export function allowedMapper(): LocalResult { return 'ok'; }
  `);

  assert.equal(messages.length, 0);
});
