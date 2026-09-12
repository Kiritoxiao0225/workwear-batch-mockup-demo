import { describe, expect, it } from 'vitest';
import {
  compileArtworkRequirements,
  dependencyIssues,
  imageDependencies,
  imageLabels,
  normalizeImageLabels,
  scopedSourceRequirement,
} from '@/lib/artwork-reliability';

const input = (text: string, extra: Record<string, unknown> = {}) => ({
  sourceRequirementText: text,
  instruction: '使用图1的完整标志',
  layoutNote: '',
  primaryImageLabel: '图1',
  primaryImageRole: 'content' as const,
  referenceImages: [] as Array<{ label: string }>,
  printPlacement: { key: 'leftChest' },
  ...extra,
});

describe('image label normalization', () => {
  it('R-01: 图5+2026 keeps the year 2026 as content and does not invent 图2026', () => {
    const value = normalizeImageLabels('研+图5+2026');
    expect(value).toContain('2026');
    expect(value).not.toContain('图2026');
    expect(imageLabels(value)).toEqual(['图5']);
  });
  it.each([
    ['图1+图2', '图1+图2'],
    ['图1+2', '图1+图2'],
    ['图1+2+3', '图1+图2+图3'],
    ['图一＋图二', '图1+图2'],
    ['图片 ２', '图2'],
    ['第三张图片', '图3'],
    ['第三行', '第三行'],
    ['图十二', '图12'],
  ])('normalizes %s to %s', (from, to) => {
    expect(normalizeImageLabels(from)).toBe(to);
  });
  it.each([
    ['图5+2026'],
    ['图1+宽20cm'],
    ['图3+500'],
    ['电话+13800138000'],
    ['数量3+5件'],
  ])('%s does not expand trailing numbers into image labels', (text) => {
    const normalized = normalizeImageLabels(text);
    // The only explicit 图N in these strings must stay the only image label.
    expect(imageLabels(normalized)).toEqual(imageLabels(text));
  });
  it('图1+2 still expands the shorthand image number', () => {
    expect(imageLabels('图1+2')).toEqual(['图1', '图2']);
  });
});

describe('scoped source requirement without colons', () => {
  it('R-02: 正面 图一／后背 图二 without colons scopes to the requested placement only', () => {
    const scope = scopedSourceRequirement('正面 图一\n后背 图二', 'frontCenter', '图1');
    expect(scope.ambiguous).toBe(false);
    expect(imageLabels(scope.text)).toEqual(['图1']);
    expect(scope.text).not.toContain('后背');
  });
  it('the back placement of the same source scopes to 图二 only', () => {
    const scope = scopedSourceRequirement('正面 图一\n后背 图二', 'back', '图2');
    expect(scope.ambiguous).toBe(false);
    expect(imageLabels(scope.text)).toEqual(['图2']);
  });
  it('full-width spaces and full-width punctuation keep working', () => {
    const scope = scopedSourceRequirement('正面　图一（扇形）\n后背　图二', 'frontCenter', '图1');
    expect(scope.ambiguous).toBe(false);
    expect(imageLabels(scope.text)).toEqual(['图1']);
  });
  it('same-line multiple placements separated by commas are split', () => {
    const scope = scopedSourceRequirement('正面 图一，后背 图二', 'frontCenter', '图1');
    expect(scope.ambiguous).toBe(false);
    expect(imageLabels(scope.text)).toEqual(['图1']);
    expect(scope.text).not.toContain('后背');
  });
  it('continuation lines without a placement header stay in the previous section', () => {
    const scope = scopedSourceRequirement('正面 图一\n下方加一行小字\n后背 图二', 'frontCenter', '图1');
    expect(imageLabels(scope.text)).toEqual(['图1']);
    expect(scope.text).toContain('下方加一行小字');
  });
  it('global font/color lines are retained for the scoped placement', () => {
    const scope = scopedSourceRequirement('正面 图一\n后背 图二\n字体 黑体', 'frontCenter', '图1');
    expect(scope.text).toContain('字体：黑体');
    expect(imageLabels(scope.text)).toEqual(['图1']);
  });
  it('unknown placement with headers stays ambiguous instead of leaking every section', () => {
    const scope = scopedSourceRequirement('正面 图一\n后背 图二', null, '图1');
    expect(scope.ambiguous).toBe(true);
    expect(scope.text).toBe('');
  });
  it('a source without any placement header keeps the whole text (legacy behavior)', () => {
    const scope = scopedSourceRequirement('只要图1的内容，保留红底', 'leftChest', '图1');
    expect(scope.ambiguous).toBe(false);
    expect(scope.text).toBe('只要图1的内容，保留红底');
  });
  it('colon-delimited sources keep the original scoping behavior', () => {
    const scope = scopedSourceRequirement('左胸：图1；后背：图2', 'leftChest', '图1');
    expect(scope.ambiguous).toBe(false);
    expect(imageLabels(scope.text)).toEqual(['图1']);
  });
});

describe('requirements contract built from colon-less WPS text', () => {
  it('front placement only requires its own image and reports no missing bindings', () => {
    const contract = compileArtworkRequirements(input('正面 图一\n后背 图二', {
      printPlacement: { key: 'frontCenter' },
      referenceImages: [{ label: '图1' }],
    }));
    expect(contract.issues).toEqual([]);
    expect(contract.dependencies.map(dep => dep.label)).toEqual(['图1']);
    expect(contract.scopedSource).not.toContain('后背');
  });
  it('a colon-less source that requires an unbound image is blocked before paid work', () => {
    const issues = dependencyIssues(input('正面 图一和图二都用上', {
      printPlacement: { key: 'frontCenter' },
      referenceImages: [],
    }));
    expect(issues.join(' ')).toContain('图2');
  });
});

describe('image dependency roles', () => {
  it('both images of 图1+图2 are content dependencies', () => {
    const labels = imageDependencies('正面：图1+图2，两张标志都要保留').map(dep => `${dep.label}:${dep.role}`);
    expect(labels).toContain('图1:content');
    expect(labels).toContain('图2:content');
  });
  it('year 2026 in a real-style clause does not become an image dependency', () => {
    const labels = imageDependencies('POLO衫：研+图5+2026【参考图四】').map(dep => dep.label);
    expect(labels).toContain('图5');
    expect(labels).toContain('图4');
    expect(labels).not.toContain('图2026');
  });
});

describe('B3 explicit per-image versions', () => {
  const text = '货号:JSH-JSD33-淡蓝-L 左胸：图一图二各做一版 只要logo，下面的字都改成康悦';
  it.each(['图1', '图2'])('%s only needs its own explicitly selected version', primary => {
    const contract = compileArtworkRequirements(input(text, { primaryImageLabel: primary, instruction: `${primary}版，只要logo，下面的字改成康悦` }));
    expect(contract.issues).toEqual([]);
    expect(contract.inputs).toEqual([{ sourceLabel: primary, inputLabel: '图1', roles: ['content'] }]);
    expect(imageLabels(contract.scopedSource)).toEqual([primary]);
    expect(contract.scopedSource).toContain('康悦');
    expect(contract.sourceText).toBe(text);
  });
  it('handles a legacy prompt repeating the alternatives without requiring the other version', () => {
    const contract = compileArtworkRequirements(input(text, { primaryImageLabel: '图2', instruction: text, generationPrompt: text }));
    expect(contract.issues).toEqual([]);
    expect(imageLabels(contract.instruction)).toEqual(['图2']);
  });
  it.each(['图一和图二各做一版', '图1、图2分别制作一版', '图1+2各出1版'])('supports the explicit list %s', list => {
    expect(dependencyIssues(input(`左胸：${list}，只要logo`))).toEqual([]);
  });
  it('preserves additional shared font references and their roles', () => {
    const contract = compileArtworkRequirements(input('左胸：图1图2各做一版，字体参考图3', {
      primaryImageLabel: '图2', instruction: '图2的logo，字体参考图3', referenceImages: [{ label: '图3' }],
    }));
    expect(contract.issues).toEqual([]);
    expect(contract.dependencies.map(dep => `${dep.label}:${dep.role}`)).toEqual(['图2:content', '图3:font']);
    expect(dependencyIssues(input('左胸：图1图2各做一版，字体参考图3')).join('；')).toContain('图3');
  });
  it('still rejects joint compositions, extra missing inputs and an unselected version', () => {
    expect(dependencyIssues(input('左胸：图一图二合在一起，只要logo')).join('；')).toContain('图2');
    expect(dependencyIssues(input(text, { instruction: '图1版，再加图3' })).join('；')).toContain('图3');
    expect(dependencyIssues(input(text, { primaryImageLabel: '图3', instruction: '图3版' })).join('；')).toContain('分支');
  });
  it('keeps content plus style-only reference and same-image multi-position contracts', () => {
    const styled = compileArtworkRequirements(input('左胸：图1内容，图2仅风格参考', {
      instruction: '图1内容，图2仅风格参考', referenceImages: [{ label: '图2' }],
    }));
    expect(styled.issues).toEqual([]);
    expect(styled.inputs[1].roles).toEqual(['reference']);
    for (const placement of ['leftChest', 'back']) {
      expect(dependencyIssues(input('两件衣服同稿。左胸：图1；后背：图1', { printPlacement: { key: placement } }))).toEqual([]);
    }
  });
});

it('B3 scopes only the alternative clause, preserving exact surrounding text and punctuation', () => {
  const source = '左胸：图一图二各做一版，文字“ＡＢＣ／康悦”不要改变。';
  const contract = compileArtworkRequirements(input(source));
  expect(contract.scopedSource).toContain('，文字“ＡＢＣ／康悦”不要改变。');
  expect(contract.sourceText).toBe(source);
});

it("B3 does not narrow a negated per-image alternative", () => {
  expect(dependencyIssues(input("左胸：不要图1图2各做一版，要合在一起")).join("；")).toContain("图2");
});
