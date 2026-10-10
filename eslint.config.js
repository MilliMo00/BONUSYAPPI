import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/server/drizzle/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // CLI-скрипты печатают результат в консоль — это их интерфейс.
  { files: ['apps/server/src/cli/**'], rules: { 'no-console': 'off' } },
);
