import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
export default ts.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.wrangler/**',
      'worker-configuration.d.ts',
      'runner/**',
      'scripts/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        AbortSignal: 'readonly',
        performance: 'readonly',
        TextEncoder: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        addEventListener: 'readonly',
        removeEventListener: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        ExecutionContext: 'readonly',
        ScheduledController: 'readonly',
        ExportedHandler: 'readonly',
        D1Database: 'readonly',
        Env: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': hooks, 'jsx-a11y': a11y },
    rules: {
      ...hooks.configs.recommended.rules,
      ...a11y.configs.recommended.rules,
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['region'] }],
      'react-hooks/set-state-in-effect': 'off',
    },
  },
);
