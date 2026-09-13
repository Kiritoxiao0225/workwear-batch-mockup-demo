import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', maxWorkers: 1, fileParallelism: false, include: ['batch-mockup/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000 } });
