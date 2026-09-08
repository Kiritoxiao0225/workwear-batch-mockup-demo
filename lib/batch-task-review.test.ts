import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  artworkRecipeFingerprint,
  createConfirmedMockupTasksFromReviews,
  createMockupTasksFromReviews,
  editedArtworkUnit,
  preparedArtworkUnit,
  taskReviewDisplayGroups,
  unitCreationIssues,
  unitReviewIssues,
  type TaskReview,
} from '@/lib/batch-task-review';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';

const taskReviewSnapshot = taskReviewFixture;

describe('task review snapshot', () => {
  it('splits multi-garment and multi-version source rows into generation units', () => {
    const reviews = taskReviewSnapshot();
    expect(reviews).toHaveLength(5);
    expect(reviews[1].units).toHaveLength(3);
    expect(reviews[1].source.materials).toHaveLength(5);
    expect(reviews.flatMap((review) => review.source.materials)).toHaveLength(11);
    expect(reviews[1].units[2].logo.materialId).toBe('snapshot-02-m5');
    expect(reviews[1].units[2].referenceMaterialIds).toEqual(['snapshot-02-m4']);
    expect(reviews[1].units[1].referenceMaterialIds).toEqual([]);
    expect(reviews[1].units[2].instruction).toContain('文字“研” + 图5 + 文字“2026”');
    expect(reviews[1].units[2].instruction).toContain('图4仅作参考');
    expect(reviews[3].units.map((unit) => unit.variantLabel)).toEqual(['图1版', '图2版']);
    expect(reviews[2].units[0].referenceMaterialIds).toEqual([]);
    expect(reviews[2].units[1].referenceMaterialIds).toEqual(['snapshot-03-m2']);
    expect(reviews[3].units.map((unit) => unit.sourceScope)).toEqual(['subject', 'subject']);
    expect(reviews[2].units[0].placement).toBe('frontCenter');
    expect(reviews[0].units[0].logo.materialId).toBe('snapshot-01-m1');
    expect(reviews[0].units[0].textMode).toBe('replace');
    expect(reviews[0].units[0].exactText).toBe('poppy手机数码');
    expect(reviews[0].units[0].sourceScope).toBe('subject');
    expect(reviews[0].units[0].instruction).toContain('手势主体');
    expect(reviews[0].units[0].instruction).toContain('图1中的 Logo 图形加文字“poppy手机数码”');
    expect(reviews[0].units[0].instruction).toContain('保留音符');
  });

  it('keeps one WPS parent record while filtering its artwork children', () => {
    const reviews = taskReviewSnapshot();
    const allGroups = taskReviewDisplayGroups(reviews, 'all');
    expect(allGroups).toHaveLength(5);
    expect(allGroups[1].review.source.recordId).toBe('snapshot-02');
    expect(allGroups[1].review.source.materials).toHaveLength(5);
    expect(allGroups[1].units).toHaveLength(3);

    const mixedReviews = reviews.map((review) => review.source.recordId === 'snapshot-02'
      ? {
          ...review,
          units: review.units.map((unit, index) => ({ ...unit, confirmed: index === 0 })),
        }
      : review);
    const confirmedGroups = taskReviewDisplayGroups(mixedReviews, 'confirmed');
    const confirmedParent = confirmedGroups.find((group) => group.review.source.recordId === 'snapshot-02');
    expect(confirmedParent?.units).toHaveLength(1);
    expect(confirmedParent?.review.units).toHaveLength(3);
  });

  it('maps all user-supplied local originals as generation-ready test sources', () => {
    const materials = taskReviewSnapshot().flatMap((review) => review.source.materials);
    expect(materials).toHaveLength(11);
    for (const material of materials) {
      expect(material.previewUrl).toMatch(/^\/task-review-originals\/row\d+-\d+\.png$/u);
      expect(material.url).toBe(material.previewUrl);
      const assetPath = join(process.cwd(), 'public', material.previewUrl as string);
      expect(statSync(assetPath).size).toBeGreaterThan(1_000);
    }
  });

  it('requires clothing style, placement, logo source and text decision before confirmation', () => {
    const review = taskReviewSnapshot()[0];
    const issues = unitReviewIssues(review, review.units[0]);
    expect(issues).toContain('请确认并选择衣服款式');
    expect(issues).toContain('请生成或上传可确认的完整制作图案');
    expect(unitCreationIssues(review, review.units[0])).toContain('该生成单元还没有人工确认');
  });
});

describe('confirmed review conversion', () => {
  it('combines different placements of one garment version into one mockup task', () => {
    const source = taskReviewSnapshot()[2].source;
    const review: TaskReview = {
      source,
      summary: '',
      units: ['leftChest', 'back'].map((placement, index) => ({
        id: `unit-${index}`,
        garmentLabel: '301SRX 冰川灰',
        variantLabel: '版本1',
        productCode: '301SRX',
        placement: placement as 'leftChest' | 'back',
        logo: { materialId: source.materials[0].id, url: 'data:image/png;base64,AA==', name: '图1.png' },
        referenceMaterialIds: [],
        sourceScope: 'wholeImage',
        textMode: 'keep',
        exactText: '',
        layoutNote: '',
        instruction: `制作${placement}`,
        ambiguities: [],
        artworkDraft: null,
        needsRegeneration: false,
        confirmed: true,
      })),
    };
    const tasks = createMockupTasksFromReviews(
      [review],
      new Date('2026-08-30T00:00:00.000Z'),
      () => 'task-1',
    );
    expect(tasks).toHaveLength(1);
    expect(Object.keys(tasks[0].placements).sort()).toEqual(['back', 'leftChest']);
  });

  it('fails fast when a unit has not passed the confirmation gate', () => {
    const review = taskReviewSnapshot()[0];
    expect(() => createMockupTasksFromReviews([review])).toThrow('snapshot-01-u1 不能创建批量任务');
  });

  it('creates tasks from confirmed units without being blocked by pending rows', () => {
    const source = taskReviewSnapshot()[2].source;
    const review: TaskReview = {
      source,
      summary: '',
      units: [
        {
          id: 'confirmed-unit',
          garmentLabel: '301SRX 冰川灰',
          variantLabel: '版本1',
          productCode: '301SRX',
          placement: 'leftChest',
          logo: { materialId: source.materials[0].id, url: 'data:image/png;base64,AA==', name: 'confirmed.png' },
          referenceMaterialIds: [],
          sourceScope: 'wholeImage',
          textMode: 'keep',
          exactText: '',
          layoutNote: '',
          instruction: '制作左胸',
          ambiguities: [],
          artworkDraft: null,
          needsRegeneration: false,
          confirmed: true,
        },
        {
          ...taskReviewSnapshot()[2].units[1],
          id: 'pending-unit',
        },
      ],
    };

    const tasks = createConfirmedMockupTasksFromReviews(
      [review],
      new Date('2026-08-30T00:00:00.000Z'),
      () => 'task-confirmed',
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task-confirmed');
    expect(Object.keys(tasks[0].placements)).toEqual(['leftChest']);
  });

  it('keeps a previous candidate visible but blocks confirmation after its recipe changes', () => {
    const review = taskReviewSnapshot()[0];
    const unit = {
      ...review.units[0],
      productCode: 'B01SD',
      logo: {
        ...review.units[0].logo,
        url: 'data:image/png;base64,AA==',
      },
      needsRegeneration: true,
    };

    expect(unit.logo.url).toBeTruthy();
    expect(unitReviewIssues(review, unit)).toContain('制作要求或主要素材已修改，请按新要求重新生成完整制作图案');
  });
});

describe('task review artwork state transitions', () => {
  it('does not let a stale async result overwrite a changed recipe', () => {
    const current = taskReviewSnapshot()[0].units[0];
    const fingerprint = artworkRecipeFingerprint(current);
    const changed = { ...current, instruction: `${current.instruction}换成蓝色` };

    expect(() => preparedArtworkUnit(changed, fingerprint, {
      draft: createLegacyArtworkDraft('data:image/png;base64,AA=='),
      url: 'data:image/png;base64,AA==',
      name: 'stale.png',
    })).toThrow('这次结果没有覆盖当前图案');
    expect(changed.logo.url).toBeNull();
  });

  it('saves deterministic edits without requesting model regeneration', () => {
    const current = {
      ...taskReviewSnapshot()[0].units[0],
      logo: {
        ...taskReviewSnapshot()[0].units[0].logo,
        url: 'data:image/png;base64,b2xk',
      },
      needsRegeneration: true,
      confirmed: true,
    };
    const draft = createLegacyArtworkDraft('data:image/png;base64,b2xk');
    const next = editedArtworkUnit(current, {
      draft,
      url: 'data:image/png;base64,bmV3',
      name: 'edited.png',
    });

    expect(next.logo.url).toBe('data:image/png;base64,bmV3');
    expect(next.needsRegeneration).toBe(false);
    expect(next.confirmed).toBe(false);
  });
});
