import { describe, expect, it } from 'vitest';

import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { buildTaskReviewPrompt, normalizeTaskReview, parseTaskReviewAnalysis } from '@/lib/task-review-analysis';

function sourceRecord(requirementText: string): SourceTaskRecord {
  return {
    recordId: 'record-1',
    customerId: '客户A',
    revision: '第1次',
    requirementText,
    productStyleText: 'B01SD-活力黑',
    materials: [
      { id: 'material-1', name: '图1', description: '胜利手势 Logo', previewUrl: '/图1.png', url: 'data:image/png;base64,AA==' },
      { id: 'material-2', name: '图2', description: '第二张参考图', previewUrl: '/图2.png', url: 'data:image/png;base64,AA==' },
    ],
  };
}

function analysisContent(input: {
  logoMaterialId?: string | null;
  sourceScope?: 'subject' | 'subjectWithFrame' | 'wholeImage' | 'custom';
  textMode?: 'keep' | 'replace' | 'none' | null;
  exactText?: string;
  instruction: string;
  generationPrompt?: string;
  layoutNote?: string;
  ambiguities?: string[];
}) {
  return JSON.stringify({
    records: [{
      recordId: 'record-1',
      summary: '一条左胸任务',
      units: [{
        id: 'record-1-u1',
        garmentLabel: 'B01SD 活力黑',
        variantLabel: '版本1',
        productCode: null,
        placement: 'leftChest',
        logoMaterialId: input.logoMaterialId ?? null,
        referenceMaterialIds: [],
        ...(input.sourceScope ? { sourceScope: input.sourceScope } : {}),
        textMode: input.textMode ?? null,
        exactText: input.exactText ?? '',
        layoutNote: input.layoutNote ?? 'Logo 改为绿色',
        generationPrompt: input.generationPrompt,
        instruction: input.instruction,
        ambiguities: input.ambiguities ?? [],
      }],
    }],
  });
}

describe('plain text WPS requirements', () => {
  it('renders hotel wording without treating the requirement screenshot as artwork', () => {
    const source = sourceRecord('货号:B01SD-蔚来灰 左胸:诺维特酒店保洁 后背: 字体: 颜色: 工艺: 尺寸:');
    const [review] = parseTaskReviewAnalysis([source], analysisContent({ logoMaterialId: 'material-1', textMode: 'replace', exactText: '诺维特酒店保洁', layoutNote: '', instruction: '左胸制作文字“诺维特酒店保洁”。', generationPrompt: '参考图1制作文字', ambiguities: ['方案核对：主要内容素材未绑定或已不存在'] }));
    expect(review.units).toHaveLength(1);
    expect(review.units[0]).toMatchObject({ logo: { materialId: null }, textMode: 'replace', exactText: '诺维特酒店保洁', generationPrompt: '', processingRoute: 'fidelity', ambiguities: [] });
    expect(review.source).toEqual(source);
  });
  it('does not turn image-number combinations into plain text', () => {
    const [review] = parseTaskReviewAnalysis([sourceRecord('左胸:1+2')], analysisContent({ textMode: 'replace', exactText: '1+2', instruction: '左胸制作文字', layoutNote: '' }));
    expect(review.units[0].ambiguities.join('；')).toContain('原文要求使用图片');
  });
});

describe('WPS image plus text shorthand', () => {
  it('retains visual observations and restores color/font requirements when the model only kept layout', () => {
    const record = sourceRecord('后背：图1，加志愿者文字；后背排版和字体颜色参考图2');
    const raw = JSON.parse(analysisContent({ logoMaterialId: 'material-1', instruction: '后背图1加字，排版参考图2' }));
    raw.records[0].units[0].placement = 'back';
    raw.records[0].units[0].layoutNote = '参考图观察：图2后背文字为黄色，笔画较粗。';
    const [review] = parseTaskReviewAnalysis([record], JSON.stringify(raw));
    expect(review.units[0].layoutNote).toContain('文字为黄色');
    expect(review.units[0].layoutNote).toContain('后背排版和字体颜色参考图2');
    expect(review.units[0].referenceMaterialIds).toEqual(['material-2']);
  });
  it.each(['图三', '图3', '图 3', '图３'])('restores the real back reference %s even when AI omitted its requirement and material', reference => {
    const record = sourceRecord(`左胸：冲锋衣：图一 POLO衫：研+图5+2026【参考图四】\n后背：冲锋衣：宜宾学院研究生会志愿者【做扇形】 下面加图二 + 奉献、友爱、互助、进步 （后背排版和字体颜色参考${reference}）\n左袖：图一`);
    record.materials = Array.from({ length: 5 }, (_, index) => ({ id: `material-${index + 1}`, name: `图${index + 1}`, description: '', url: `/image-${index + 1}.png`, previewUrl: `/image-${index + 1}.png` }));
    const raw = JSON.parse(analysisContent({ logoMaterialId: 'material-2', instruction: '后背使用图二，并添加志愿者文字' }));
    raw.records[0].units[0].placement = 'back';
    const [review] = parseTaskReviewAnalysis([record], JSON.stringify(raw));
    expect(review.units[0].referenceMaterialIds).toEqual(['material-3']);
    expect(review.units[0].layoutNote).toContain('后背排版和字体颜色参考图3');
    expect(record.requirementText).toContain(reference);
  });
  it('normalizes “左胸:1+poppy手机数码” to image 1 plus exact text', () => {
    const record = sourceRecord('货号:B01SD-活力黑- 左胸:1+poppy手机数码（logo做绿色的吧） 后背: 字体: 颜色:');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      textMode: 'keep',
      instruction: '左胸 Logo 改为绿色。',
      ambiguities: ['“1+poppy手机数码”是组合标识还是备注，需客户确认。'],
    }));
    const [unit] = review.units;

    expect(unit.logo.materialId).toBe('material-1');
    expect(unit.logo.url).toBeNull();
    expect(unit.textMode).toBe('replace');
    expect(unit.sourceScope).toBe('subject');
    expect(unit.exactText).toBe('poppy手机数码');
    expect(unit.instruction).toContain('左胸使用图1中的 Logo 图形，搭配文字“poppy手机数码”');
    expect(unit.instruction).toContain('Logo 改为绿色');
    expect(unit.instruction).not.toContain('WPS 原文未明确要求删除');
    expect(unit.ambiguities).not.toContain('“1+poppy手机数码”是组合标识还是备注，需客户确认。');
  });

  it.each(['图1', '图一', '图 1'])('keeps an existing %s plus text explanation without duplicating it', (imageLabel) => {
    const record = sourceRecord('左胸:1+poppy手机数码（logo做绿色的吧）');
    const instruction = `左胸使用${imageLabel}作为Logo图形来源，替换文字为poppy手机数码，logo做绿色，文字放在图形下方`;
    const [review] = parseTaskReviewAnalysis([record], analysisContent({ instruction }));

    expect(review.units[0].instruction).toBe(instruction);
    expect(review.units[0].logo.materialId).toBe('material-1');
    expect(review.units[0].exactText).toBe('poppy手机数码');
  });

  it('only fills the missing target text when the image source is already explained', () => {
    const record = sourceRecord('左胸:1+poppy手机数码');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      instruction: '左胸使用图1，Logo 改为绿色。',
    }));

    expect(review.units[0].instruction).toBe('搭配文字“poppy手机数码”。左胸使用图1，Logo 改为绿色。');
  });

  it('only fills the missing image source when the target text is already explained', () => {
    const record = sourceRecord('左胸:1+poppy手机数码');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      instruction: '文字为poppy手机数码，图10仅参考字体。',
    }));

    expect(review.units[0].instruction).toBe('左胸使用图1中的 Logo 图形。文字为poppy手机数码，图10仅参考字体。');
  });

  it('does not guess when the suffix is only another image number', () => {
    const record = sourceRecord('左胸:1+2');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      instruction: '左胸使用内容待确认。',
      ambiguities: ['“1+2”可能表示图1与图2，需确认。'],
    }));
    const [unit] = review.units;

    expect(unit.logo.materialId).toBeNull();
    expect(unit.textMode).toBeNull();
    expect(unit.exactText).toBe('');
    expect(unit.ambiguities).toContain('“1+2”可能表示图1与图2，需确认。');
  });

  it('tells the model that bare image ordinals plus text have a fixed meaning', () => {
    const prompt = buildTaskReviewPrompt([sourceRecord('左胸:1+poppy手机数码')]);
    expect(prompt).toContain('“左胸:1+poppy手机数码”必须理解为');
    expect(prompt).toContain('garmentLabel="款式待确认"');
    expect(prompt).toContain('图1作为 Logo 图形来源');
    expect(prompt).toContain('音符、文字、边框、装饰、内部细节与负形都属于前景');
    expect(prompt).not.toContain('删除接触图片边缘的矩形背景、截图画布和外围装饰');
  });

  it('normalizes bare “正面 图一” to the standard front-center placement', () => {
    const record = sourceRecord('301SRX-黑色\n正面 图一\n后背 图一前三排 按照图二做');
    const content = JSON.stringify({
      records: [{
        recordId: 'record-1',
        summary: '正面和后背各一个制作单元',
        units: [
          {
            id: 'record-1-u1', garmentLabel: '301SRX 黑色', variantLabel: '版本1', productCode: null,
            placement: null, logoMaterialId: 'material-1', referenceMaterialIds: [], sourceScope: 'wholeImage',
            textMode: 'keep', exactText: '', layoutNote: '', instruction: '正面使用图1。',
            ambiguities: ['正面位置未细分左胸或右胸，需确认。'],
          },
          {
            id: 'record-1-u2', garmentLabel: '301SRX 黑色', variantLabel: '版本1', productCode: null,
            placement: 'back', logoMaterialId: 'material-1', referenceMaterialIds: ['material-2'], sourceScope: 'custom',
            textMode: 'keep', exactText: '', layoutNote: '图2仅作后背排版参考。', instruction: '后背取图1前三排，按照图2做。', ambiguities: [],
          },
        ],
      }],
    });

    const [review] = parseTaskReviewAnalysis([record], content);

    expect(review.units).toHaveLength(2);
    expect(review.units[0].placement).toBe('frontCenter');
    expect(review.units[0].ambiguities).toEqual([]);
    expect(review.units[1].placement).toBe('back');
    expect(review.units[1].referenceMaterialIds).toEqual(['material-2']);
  });

  it.each(['后脖', '后领', '后领口', '后颈', '后背上方'])('repairs the actual 301SRX order with %s without moving its reference to the front', position => {
    const record = sourceRecord(`301SRX-黑色 \n正面 图一\n${position}  图一前三排  按照图二做 \n正面高35cm 后背宽8`);
    const raw = JSON.parse(analysisContent({ logoMaterialId: 'material-1', instruction: '正面使用图一', sourceScope: 'subject' }));
    raw.records[0].units[0].placement = 'frontCenter';
    raw.records[0].units[0].layoutNote = '';
    raw.records[0].units.push({ ...raw.records[0].units[0], id: 'record-1-u2', placement: position, referenceMaterialIds: ['material-2'], instruction: '在后领使用图一，按照图二样式制作' });
    const [review] = parseTaskReviewAnalysis([record], JSON.stringify(raw));
    expect(review.units[0].referenceMaterialIds).toEqual([]);
    expect(review.units[0].sourceScope).toBe('subject');
    expect(review.units[1]).toMatchObject({ placement: 'back', referenceMaterialIds: ['material-2'], sourceScope: 'custom' });
    expect(review.units[1].instruction).toContain('图1前三排');
    expect(review.units[1].ambiguities.join('；')).toContain('用途尚未明确');
    expect(normalizeTaskReview(review)).toEqual(review);
    const clarified = structuredClone(review);
    clarified.units[1].layoutNote = '图2只参考后领图案的排版，内容取图1前三排。';
    expect(normalizeTaskReview(clarified).units[1].ambiguities).toEqual([]);
    expect(record.requirementText).toContain(position);
  });

  it('preserves and flags a reference whose position conflicts with the source', () => {
    const record = sourceRecord('正面 图一\n后脖 图一前三排 按照图二做');
    const raw = JSON.parse(analysisContent({ logoMaterialId: 'material-1', instruction: '正面使用图一，排版参考图二' }));
    Object.assign(raw.records[0].units[0], { placement: 'frontCenter', referenceMaterialIds: ['material-2'], layoutNote: '' });
    const [review] = parseTaskReviewAnalysis([record], JSON.stringify(raw));
    expect(review.units[0].referenceMaterialIds).toEqual(['material-2']);
    expect(review.units[0].ambiguities.join('；')).toContain('位置归属');
  });

  it('does not infer the front from a shared image when the model omitted back-neck placement', () => {
    const record = sourceRecord('正面 图一\n后脖 图一前三排 按照图二做');
    const raw = JSON.parse(analysisContent({ logoMaterialId: 'material-1', instruction: '在工作服后脖位置取用图一的前三排，按照图二样式制作' }));
    raw.records[0].units[0].placement = null;
    const [review] = parseTaskReviewAnalysis([record], JSON.stringify(raw));
    expect(review.units[0].placement).toBe('back');
    expect(review.units[0].referenceMaterialIds).toEqual(['material-2']);
    raw.records[0].units[0].instruction = '使用图一';
    const [unknown] = parseTaskReviewAnalysis([record], JSON.stringify(raw));
    expect(unknown.units[0].placement).toBeNull();
    expect(unknown.units[0].ambiguities.join('；')).toContain('多个位置');
  });

  it('declares bare front and right chest as supported positions', () => {
    const prompt = buildTaskReviewPrompt([sourceRecord('正面 图一')]);

    expect(prompt).toContain('placement 必须为 frontCenter');
    expect(prompt).toContain('frontCenter|leftChest|rightChest|back');
    expect(prompt).toContain('“按照图N做”只绑定同一位置段');
  });

  it('normalizes text + graphic + text into ordered components and keeps the bracketed image reference-only', () => {
    const record = sourceRecord('B01SD-月牙白-L 左胸:POLO衫:研+图2+2026【参考图一】');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      logoMaterialId: 'material-2',
      textMode: 'replace',
      exactText: '研 2026',
      instruction: 'POLO 左胸使用图2，并添加研和2026，参考图1。',
      generationPrompt: '使用图2字标，参照图1胸前印花：研在左侧，笔画粗细变化自然，中间校名，右侧2026，纯白背景。',
      layoutNote: '参考图观察：研的字形舒展，整组紧凑横排。',
    }));
    const [unit] = review.units;

    expect(unit.logo.materialId).toBe('material-2');
    expect(unit.referenceMaterialIds).toEqual(['material-1']);
    expect(unit.exactText).toBe('研 2026');
    expect(unit.instruction).toBe('POLO 左胸使用图2，并添加研和2026，参考图1。');
    expect(unit.layoutNote).not.toContain('原文未说明');
    expect(unit.generationPrompt).toBe('使用图2字标，参照图1胸前印花：研在左侧，笔画粗细变化自然，中间校名，右侧2026，纯白背景。');
    expect(unit.layoutNote).toContain('研的字形舒展');
    expect(unit.instruction).not.toContain('居中');
  });

  it('retains an unexplained model binding and marks it for review instead of deleting it', () => {
    const record = sourceRecord('后背:图2');
    const result = JSON.parse(analysisContent({
      logoMaterialId: 'material-2',
      textMode: 'keep',
      instruction: '后背使用图2完整校徽。',
    })) as { records: Array<{ units: Array<Record<string, unknown>> }> };
    result.records[0].units[0].referenceMaterialIds = ['material-1'];
    const [review] = parseTaskReviewAnalysis([record], JSON.stringify(result));

    expect(review.units[0].referenceMaterialIds).toEqual(['material-1']);
    expect(review.units[0].ambiguities.join('；')).toContain('图1已绑定为参考');
  });

  it('reuses the original attachment only when the complete artwork is kept unchanged', () => {
    const record = sourceRecord('左胸:图1原样保留');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      logoMaterialId: 'material-1',
      sourceScope: 'wholeImage',
      textMode: 'keep',
      instruction: '左胸直接使用图1完整图案。',
    }));

    expect(review.units[0].logo.url).toBe(record.materials[0].url);
    expect(review.units[0].sourceScope).toBe('wholeImage');
  });

  it('keeps embedded source text without treating the white canvas as finished artwork', () => {
    const record = sourceRecord('左胸:使用图1校徽');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      logoMaterialId: 'material-1',
      textMode: 'keep',
      instruction: '左胸使用图1校徽。',
    }));

    expect(review.units[0].logo.url).toBeNull();
    expect(review.units[0].sourceScope).toBe('subject');
    expect(review.units[0].textMode).toBe('keep');
  });

  it('keeps a source attachment separate from a newly composed artwork', () => {
    const record = sourceRecord('左胸:图1+新文字');
    const [review] = parseTaskReviewAnalysis([record], analysisContent({
      logoMaterialId: 'material-1',
      textMode: 'replace',
      exactText: '新文字',
      instruction: '使用图1图形并添加新文字。',
    }));

    expect(review.units[0].logo.url).toBeNull();
    expect(review.units[0].sourceScope).toBe('subject');
  });
});


describe('empty WPS fields are not print requests', () => {
  it('drops an invented back unit and optional omissions from the real shorthand case', () => {
    const source = sourceRecord('货号:B01SD-活力黑- 左胸:1+poppy手机数码（logo做绿色的吧） 后背: 字体: 颜色: 工艺: 尺寸：');
    const raw = JSON.parse(analysisContent({ instruction: '左胸使用图1并添加文字poppy手机数码，logo绿色', logoMaterialId: 'material-1', ambiguities: ['未指定logo字体、具体尺寸、工艺要求'] }));
    raw.records[0].summary = '错误地拆成左胸和后背两个任务';
    raw.records[0].units.push({ ...raw.records[0].units[0], id: 'record-1-u2', placement: 'back', logoMaterialId: null, instruction: '后背未指定制作内容', ambiguities: ['未指定后背图案'] });
    const [review] = parseTaskReviewAnalysis([source], JSON.stringify(raw));
    expect(review.units).toHaveLength(1);
    expect(review.units[0]).toMatchObject({ placement: 'leftChest', ambiguities: [], exactText: 'poppy手机数码' });
    expect(review.summary).not.toContain('两个任务');
  });
  it.each(['左胸:图1 后背:图2 字体: 尺寸:', '左胸:图1 后背: 字体: 后背:图2', '左胸图1，背面图2'])('retains actual back requests: %s', requirement => {
    const raw = JSON.parse(analysisContent({ instruction: '左胸图1', logoMaterialId: 'material-1' }));
    raw.records[0].units.push({ ...raw.records[0].units[0], id: 'record-1-u2', placement: 'back', logoMaterialId: 'material-2', instruction: '背面图2' });
    const [review] = parseTaskReviewAnalysis([sourceRecord(requirement)], JSON.stringify(raw));
    expect(review.units).toHaveLength(2);
    expect(review.units[0].variantLabel).toBe(review.units[1].variantLabel);
  });
  it('keeps meaningful content ambiguity even when it also mentions font', () => {
    const ambiguity = '未指定字体，目标文字无法辨认';
    const [review] = parseTaskReviewAnalysis([sourceRecord('左胸:1+2')], analysisContent({ instruction: '左胸图1与图2', logoMaterialId: 'material-1', ambiguities: [ambiguity] }));
    expect(review.units[0].ambiguities).toContain(ambiguity);
  });
});


it('pairs matching front/back image alternatives into two garment versions rather than four', () => {
  const source = sourceRecord('货号:920CYJD-黑色-L\n左胸：图一 图二各出一版\n后背：图一 图二各出一版\n右胸：\n字体：\n工艺：');
  const raw = JSON.parse(analysisContent({ instruction: '左胸图1', logoMaterialId: 'material-1' }));
  const unit = raw.records[0].units[0];
  raw.records[0].units = ['leftChest', 'back'].flatMap((placement, face) => ['material-1', 'material-2'].map((logoMaterialId, index) => ({ ...unit, placement, logoMaterialId, id: `record-1-u${face * 2 + index + 1}`, variantLabel: `版本${face * 2 + index + 1}` })));
  const [review] = parseTaskReviewAnalysis([source], JSON.stringify(raw));
  expect(review.units.map(unit => unit.variantLabel)).toEqual(['图1版', '图2版', '图1版', '图2版']);
  const mismatched = { ...source, requirementText: '左胸：图一 图二各出一版\n后背：图二 图三各出一版' };
  expect(parseTaskReviewAnalysis([mismatched], JSON.stringify(raw))[0].units.map(unit => unit.variantLabel)).toEqual(['版本1', '版本2', '版本3', '版本4']);
});


it('does not submit the main image a second time as its own reference', () => {
  const raw = JSON.parse(analysisContent({ instruction: '左胸使用图1主体', logoMaterialId: 'material-1' }));
  raw.records[0].units[0].referenceMaterialIds = ['material-1'];
  const [review] = parseTaskReviewAnalysis([sourceRecord('左胸:图一')], JSON.stringify(raw));
  expect(review.units[0].referenceMaterialIds).toEqual([]);
});

it('persists visual source evidence separately from exact customer text and binds it to the selected material', () => {
  const raw = JSON.parse(analysisContent({ logoMaterialId: 'material-1', textMode: 'keep', instruction: '左胸使用图1原图案', layoutNote: '' }));
  raw.records[0].units[0].sourceAssessment = { version: 'artwork-source-v1', kind: 'artwork-on-object', targetDescription: '衣物胸标',
    needsReconstruction: true, evidence: ['图案被衣料褶皱拉伸'], uncertainDetails: ['首字看不清'], materialId: 'model-guessed-id' };
  const [review] = parseTaskReviewAnalysis([sourceRecord('左胸：图1')], JSON.stringify(raw));
  expect(review.units[0].sourceAssessment).toMatchObject({ kind: 'artwork-on-object', materialId: 'material-1', uncertainDetails: ['首字看不清'] });
  expect(review.units[0].exactText).toBe('');
});

it('parses and keeps a visually inferred back font reference despite an empty font field', () => {
  const source = sourceRecord('左胸:logo 后背:测试文字 字体: 颜色: 工艺: 尺寸:');
  const raw = JSON.parse(analysisContent({ logoMaterialId: null, textMode: 'replace', exactText: '测试文字', instruction: '后背制作测试文字', layoutNote: '' }));
  raw.records[0].units[0].placement = 'back';
  raw.records[0].units[0].fontReference = { materialId: 'material-2', origin: 'visual', description: '照片上部文字，笔画粗、字形方正', evidence: '图2展示后背文字区域', region: { x: .1, y: .2, width: .8, height: .25 } };
  const [review] = parseTaskReviewAnalysis([source], JSON.stringify(raw));
  expect(review.units[0].fontReference?.materialId).toBe('material-2');
  expect(review.units[0].referenceMaterialIds).toContain('material-2');
  expect(review.units[0].exactText).toBe('测试文字');
});
