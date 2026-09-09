import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'dist-electron/**',
      'release/**',
      'artifacts/**',
      'native/target/**',
      'native/vendor/**',
      '.worktrees/**',
      '.agents/**',
      '.claude/**',
      'patches/**',
      'src/lib/desktop/command-types.ts',
      'src/lib/desktop/contract.ts',
    ],
  },
  {
    files: ['**/*.{js,jsx,cjs,mjs,ts,tsx}'],
    plugins: {
      import: importPlugin,
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    // Existing suppressions also cover rules outside this spacing-only configuration.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'import/newline-after-import': [
        'error',
        { count: 1, exactCount: false, considerComments: true },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
  },
];
