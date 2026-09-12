import { describe, it } from 'vitest';
import { taskAPixelCases } from './artwork-task-a-cases';

describe('Task A actual RGBA and fixture regressions', () => {
  for (const test of taskAPixelCases) it(test.name, test.run, 20_000);
});
