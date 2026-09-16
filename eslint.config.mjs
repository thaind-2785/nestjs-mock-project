// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const implementationDeclarationRestrictions = [
  'error',
  {
    selector: 'Program > ExportNamedDeclaration > TSInterfaceDeclaration',
    message:
      'Move exported interfaces to a concern-specific contract or *.types.ts file.',
  },
  {
    selector: 'Program > ExportNamedDeclaration > TSTypeAliasDeclaration',
    message:
      'Move exported types to a concern-specific contract or *.types.ts file.',
  },
  {
    selector:
      'Program > ExportNamedDeclaration > VariableDeclaration[kind="const"]',
    message:
      'Move exported constants to a concern-specific *.constants.ts or token file.',
  },
  {
    selector: 'Program > ExportNamedDeclaration > TSEnumDeclaration',
    message:
      'Move exported enums to a concern-specific *.enums.ts or contract file.',
  },
];

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    files: [
      'src/**/*.controller.ts',
      'src/**/*.repository.ts',
      'src/**/*.service.ts',
    ],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': implementationDeclarationRestrictions,
    },
  },
);
