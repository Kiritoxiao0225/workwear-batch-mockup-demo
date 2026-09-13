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
    // Bound concurrent native canvas/Sharp work to avoid CPU oversubscription.
    maxWorkers: 2,
    include: ['app/**/*.test.ts', 'components/**/*.test.ts', 'hooks/**/*.test.ts', 'lib/**/*.test.ts', 'batch-mockup/**/*.test.ts'],
  },
});
