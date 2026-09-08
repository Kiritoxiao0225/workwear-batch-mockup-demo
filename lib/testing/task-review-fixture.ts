import type { GenerationUnit, TaskReview, TextMode } from '@/lib/batch-task-review';
import { sourceTaskSnapshot } from '@/lib/task-review-snapshot';

function reviewUnit(input: {
  id: string;
  garmentLabel: string;
  placement?: GenerationUnit['placement'];
  materialId: string;
  references?: string[];
  variantLabel?: string;
  sourceScope?: GenerationUnit['sourceScope'];
  textMode?: TextMode;
  exactText?: string;
  instruction: string;
}): GenerationUnit {
  return {
    id: input.id,
    garmentLabel: input.garmentLabel,
    variantLabel: input.variantLabel ?? '版本1',
    productCode: null,
    placement: input.placement ?? null,
    logo: { materialId: input.materialId, url: null, name: '' },
    referenceMaterialIds: input.references ?? [],
    sourceScope: input.sourceScope ?? 'subject',
    processingRoute: 'auto',
    textMode: input.textMode ?? 'keep',
    exactText: input.exactText ?? '',
    layoutNote: '',
    instruction: input.instruction,
    ambiguities: [],
    artworkDraft: null,
    needsRegeneration: false,
    confirmed: false,
  };
}

/** Test-only derived state. Production code must regenerate this from source records. */
export function taskReviewFixture(): TaskReview[] {
  const [row1, row2, row3, row4, row5] = sourceTaskSnapshot();
  return [
    {
      source: row1,
      summary: '测试任务 1',
      units: [reviewUnit({
        id: 'snapshot-01-u1', garmentLabel: 'B01SD 活力黑', placement: 'leftChest',
        materialId: 'snapshot-01-m1', textMode: 'replace', exactText: 'poppy手机数码',
        instruction: '图1中的 Logo 图形加文字“poppy手机数码”，保留音符与手势主体。',
      })],
    },
    {
      source: row2,
      summary: '测试任务 2',
      units: [
        reviewUnit({ id: 'snapshot-02-u1', garmentLabel: '719SF 黑色冲锋衣', placement: 'leftChest', materialId: 'snapshot-02-m1', instruction: '左胸使用图1。' }),
        reviewUnit({ id: 'snapshot-02-u2', garmentLabel: '719SF 黑色冲锋衣', placement: 'back', materialId: 'snapshot-02-m2', instruction: '后背使用图2并增加原文文字。' }),
        reviewUnit({ id: 'snapshot-02-u3', garmentLabel: 'B01SD 月牙白 POLO', placement: 'leftChest', materialId: 'snapshot-02-m5', references: ['snapshot-02-m4'], textMode: 'replace', exactText: '研 2026', instruction: '文字“研” + 图5 + 文字“2026”；图4仅作参考。' }),
      ],
    },
    {
      source: row3,
      summary: '测试任务 3',
      units: [
        reviewUnit({ id: 'snapshot-03-u1', garmentLabel: '301SRX 黑色', placement: 'frontCenter', materialId: 'snapshot-03-m1', sourceScope: 'wholeImage', instruction: '正前面使用完整图1。' }),
        reviewUnit({ id: 'snapshot-03-u2', garmentLabel: '301SRX 黑色', placement: 'back', materialId: 'snapshot-03-m1', references: ['snapshot-03-m2'], sourceScope: 'custom', instruction: '后背取图1前三排，排版参考图2。' }),
      ],
    },
    {
      source: row4,
      summary: '测试任务 4',
      units: [
        reviewUnit({ id: 'snapshot-04-u1', garmentLabel: '待确认衣服款式', placement: 'back', materialId: 'snapshot-04-m1', variantLabel: '图1版', instruction: '图1版。' }),
        reviewUnit({ id: 'snapshot-04-u2', garmentLabel: '待确认衣服款式', placement: 'back', materialId: 'snapshot-04-m2', variantLabel: '图2版', instruction: '图2版。' }),
      ],
    },
    {
      source: row5,
      summary: '测试任务 5',
      units: [reviewUnit({ id: 'snapshot-05-u1', garmentLabel: '9600SRX 大红', placement: 'leftChest', materialId: 'snapshot-05-m1', instruction: '左胸使用图1。' })],
    },
  ];
}
