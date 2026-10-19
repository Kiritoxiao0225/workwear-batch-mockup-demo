import { describe, expect, it } from 'vitest';
import { categoryById } from './category';
import { DEMO_MATERIAL } from './demo/material';
import { defaultDraft, LIMITS, reviewPoints } from './draft';
import { draftSchema } from './draft-schema';
import { tagFits } from './point-words';
import { BUILT_IN_LAYOUTS } from './templates';

const fabric = [
  { type: '面料', text: '面料:100%聚酯纤维', note: '', from: ['M2'] },
  { type: '面料', text: '高防水透气膜 德国SUPER-TEX', note: '轻试雨水自动滑落', from: ['M3'] },
];
const material = { ...DEMO_MATERIAL, points: [...fabric, ...DEMO_MATERIAL.points] };

describe('the default plan\'s words (10-19)', () => {
  it('puts the suppliers\' typos right, takes off a field name, and says so on the point', () => {
    const points = reviewPoints(material, categoryById('workwear'));
    const made = points.find(p => p.text.includes('聚酯'))!, tech = points.find(p => p.text.includes('SUPER-TEX'))!;
    expect(made.text).toBe('100%聚酯纤维');
    expect(tech.note).toBe('轻拭雨水自动滑落');
    expect(tech.why).toContain('已改错字：轻试→轻拭');
  });
  it('makes concise tags that pass the plan\'s own check on every master', () => {
    for (const layout of BUILT_IN_LAYOUTS) {
      const d = defaultDraft(material, layout);
      const tags = d.slots.flatMap(s => s.tags);
      expect(tags.every(t => tagFits(t, LIMITS.tag)), `${layout.id} ${JSON.stringify(tags)}`).toBe(true);
      for (const s of d.slots) expect(draftSchema.shape.slots.element.safeParse(s).success, `${layout.id} ${s.task}`).toBe(true);
      // The fabric sheet keeps the telling part of a long fabric point, whole.
      if (d.slots.some(s => s.tags.some(t => t.includes('｜')))) expect(tags).toContain('面料科技｜德国SUPER-TEX');
    }
  });
});

describe('short names from the analysis (10-19)', () => {
  it('keeps a short name made of the point\'s words and drops one that is not', () => {
    const points = reviewPoints({ points: [
      { type: '功能', text: '可呼吸冲锋衣透气面料', short: '透气面料', from: [] },
      { type: '功能', text: '可拆卸摇粒内胆', short: '可脱内胆', from: [] },
    ] }, categoryById('workwear'));
    expect(points.find(p => p.text.startsWith('可呼吸'))?.short).toBe('透气面料');
    expect(points.find(p => p.text.startsWith('可拆卸'))?.short).toBeUndefined();
  });
});

