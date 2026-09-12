import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Native canvas/Sharp suites compete for CPU; bound workers instead of relaxing assertions/timeouts.
    maxWorkers: 2,
    include: ['app/**/*.test.ts', 'components/**/*.test.ts', 'hooks/**/*.test.ts', 'lib/**/*.test.ts'],
  },
});
