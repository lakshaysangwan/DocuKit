import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    ignores: [
      'dist/**', 'worker/**', 'scripts/**', '.astro/**', 'node_modules/**', 'public/**',
      'patch*.cjs', 'patch*.js',
      // Generated locally by test/audit runs. Gitignored, so CI never sees them,
      // but `eslint .` on a dev machine otherwise reports thousands of errors
      // from Playwright's bundled report viewer.
      'playwright-report/**', 'test-results/**', '.lighthouseci/**', 'tmp/**',
    ],
  },
  {
    // The islands carry `eslint-disable react-hooks/exhaustive-deps` comments,
    // which are a hard "rule not found" error unless the plugin is registered —
    // that alone was failing CI's lint step. Registering it also turns on
    // rules-of-hooks, which catches conditionally-called hooks.
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
