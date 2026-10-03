// Root ESLint flat config shared by every workspace (apps/web, apps/server, packages/shared).
// TypeScript-aware via @typescript-eslint; Prettier formatting conflicts are disabled via
// eslint-config-prettier so ESLint only owns code-quality rules, Prettier owns style.
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // Ignore build output and dependencies across all workspaces.
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/*.config.js', '**/*.config.mjs'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // TypeScript's compiler already catches genuine undefined-reference errors;
      // no-undef false-positives on type-only references (e.g. `React.ReactElement`
      // used only as a type, with no corresponding value import).
      'no-undef': 'off',
    },
  },
  // Standing check: apps/web must never import apps/server modules directly — only HTTP
  // API calls are allowed. import/no-restricted-paths resolves each import to a real
  // filesystem path before checking the zone, so it fires regardless of how many `../`
  // segments a relative import uses — unlike a specifier-text pattern match.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './apps/web',
              from: './apps/server',
              message:
                'apps/web must never import apps/server modules directly — call the HTTP API instead.',
            },
          ],
        },
      ],
    },
  },
  // Standing check: all DuckDB access is confined to one data-access module
  // (apps/server/src/db/**) — no route handler or other backend module may
  // construct a DuckDB client directly. no-restricted-imports fires on the
  // import specifier itself, which is sufficient here since the package name
  // is fixed — unlike the filesystem-resolved apps/web boundary above.
  {
    files: ['apps/server/src/**/*.{ts,tsx}'],
    ignores: ['apps/server/src/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@duckdb/node-api',
              message:
                'DuckDB must only be accessed via the data-access module (apps/server/src/db) — import from there instead.',
            },
          ],
        },
      ],
    },
  },
  prettierConfig,
];
