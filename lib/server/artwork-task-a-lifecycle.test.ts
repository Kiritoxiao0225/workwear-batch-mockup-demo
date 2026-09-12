import { describe, it, vi } from 'vitest';
import { taskALifecycleCases } from './artwork-task-a-lifecycle-cases';
vi.mock('./production-storage', () => ({ productionStateKey: () => 'task-a-isolated', usesProductionCloud: () => false }));
describe('Task A: isolated lifecycle, real pixels/files, no paid services', () => {
  for (const test of taskALifecycleCases) it(test.name, test.run, 30_000);
});
