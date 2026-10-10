import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Все файлы работают с одной тестовой базой, поэтому выполняются последовательно.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
