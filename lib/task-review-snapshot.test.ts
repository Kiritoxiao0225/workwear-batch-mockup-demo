import { describe, expect, it } from 'vitest';

import { sourceTaskSnapshot } from '@/lib/task-review-snapshot';

describe('local WPS evidence snapshot', () => {
  it('contains only original row fields and original image references', () => {
    const records = sourceTaskSnapshot();
    expect(records).toHaveLength(5);
    expect(records.flatMap((record) => record.materials)).toHaveLength(11);
    expect(records[1].requirementText).toContain('研+图5+2026【参考图四】');
    expect(records[1].materials.map((material) => material.description)).toEqual([
      '图1', '图2', '图3', '图4', '图5',
    ]);
    expect(JSON.stringify(records)).not.toContain('layoutNote');
    expect(JSON.stringify(records)).not.toContain('instruction');
    expect(JSON.stringify(records)).not.toContain('summary');
    expect(JSON.stringify(records)).not.toContain('artworkDraft');
  });
});
