import { describe, expect, it } from 'vitest';

import {
  arcGlyphTransforms,
  artworkTextGlyphLayout,
  artworkCanvasBounds,
  artworkGraphicBounds,
  artworkDraftExactText,
  assertArtworkDraft,
  createHybridArtworkDraft,
  createLegacyArtworkDraft,
  createStructuredArtworkDraft,
  inferredArtworkLayout,
  inferredArtworkTextArc,
  snapArtworkPosition,
} from '@/lib/artwork-editor';
import { alphaContentBounds, artworkDraftCanvasBounds } from '@/lib/client/render-artwork';
import { addArtworkText } from '@/lib/artwork-layers';

describe('expanding artwork canvas', () => {
  it('preserves the original surface for content that already fits', () => {
    expect(artworkCanvasBounds([{ left: 100, top: 150, width: 500, height: 600 }])).toEqual({ left: 0, top: 0, width: 1024, height: 1024 });
  });
  it('includes oversized text on the right and content at negative coordinates without scaling', () => {
    const content = [{ left: 360, top: 400, width: 1500, height: 200 }, { left: -150.5, top: -210.2, width: 400, height: 600 }];
    expect(artworkCanvasBounds(content)).toEqual({ left: -179, top: -239, width: 2067, height: 1263 });
    expect(content[0].width).toBe(1500);
  });
  it('includes rotated graphics and does not expand for hidden layers', () => {
    const draft = createLegacyArtworkDraft('/logo.png');
    draft.graphic = { ...draft.graphic, x: 0, y: 512, width: 1200, height: 300, rotation: 90 };
    const bounds = artworkGraphicBounds(draft.graphic);
    expect(bounds.width).toBeCloseTo(300);
    expect(bounds.height).toBeCloseTo(1200);
    const surface = artworkDraftCanvasBounds(draft);
    expect(surface.left).toBeLessThanOrEqual(-178);
    expect(surface.top).toBe(-116);
    expect(surface.top + surface.height).toBe(1140);
    draft.graphic.visible = false;
    expect(artworkDraftCanvasBounds(draft)).toEqual({ left: 0, top: 0, width: 1024, height: 1024 });
  });
});

describe('artwork editor draft contract', () => {
  it('creates an editable graphic and exact text as separate layers', () => {
    const draft = createStructuredArtworkDraft({
      graphicSourceUrl: 'data:image/png;base64,AA==',
      recolorMaskUrl: 'data:image/png;base64,AQ==',
      graphicWidth: 400,
      graphicHeight: 600,
      exactText: 'poppy手机数码',
      instruction: 'Logo 改为绿色，加上准确文字',
      layoutNote: '图上字下',
      qualityScore: 82,
      blurScore: 79,
      enhancement: 'none',
      backgroundRemoval: 'general',
    });

    expect(draft.mode).toBe('structured');
    expect(draft.layout.preset).toBe('vertical');
    expect(draft.graphic.recolor).toEqual({ mode: 'solid', color: '#177a4b' });
    expect(draft.graphic.recolorMaskUrl).toBe('data:image/png;base64,AQ==');
    expect(draft.text?.value).toBe('poppy手机数码');
    expect(() => assertArtworkDraft(draft)).not.toThrow();
  });

  it('does not invent a text layer for a legacy flattened image', () => {
    const draft = createLegacyArtworkDraft('/uploads/logos/legacy.png');
    expect(draft.text).toBeNull();
    expect(() => assertArtworkDraft({
      ...draft,
      text: {
        value: '伪造文字层',
      },
    })).toThrow('旧版合并图不能伪造独立图形或文字图层');
  });

  it('preserves original colors when no recolor is requested and scales small graphics up proportionally', () => {
    const draft = createStructuredArtworkDraft({
      graphicSourceUrl: 'data:image/png;base64,AA==',
      graphicWidth: 80,
      graphicHeight: 40,
      exactText: '准确文字',
      instruction: '保留图形，加上文字',
      layoutNote: '图上字下',
      enhancement: 'standard',
      backgroundRemoval: 'general',
    });

    expect(draft.graphic.recolor).toEqual({ mode: 'original', color: null });
    expect(draft.graphic.width).toBe(500);
    expect(draft.graphic.height).toBe(250);
  });

  it('accepts a legacy structured draft without a recolor mask and keeps its source safe', () => {
    const draft = createStructuredArtworkDraft({
      graphicSourceUrl: 'data:image/png;base64,AA==',
      graphicWidth: 400,
      graphicHeight: 400,
      exactText: '',
      instruction: '保留原图',
      layoutNote: '',
      enhancement: 'none',
      backgroundRemoval: 'general',
    });
    const legacyStructured = {
      ...draft,
      graphic: {
        ...draft.graphic,
        recolorMaskUrl: undefined,
        recolor: { mode: 'solid' as const, color: '#177a4b' },
      },
    };

    expect(() => assertArtworkDraft(legacyStructured)).not.toThrow();
    expect(legacyStructured.graphic.sourceUrl).toBe('data:image/png;base64,AA==');
  });

  it('keeps the logo and each styled text as independently editable graphic layers', () => {
    const draft = createHybridArtworkDraft({
      primaryGraphic: {
        id: 'graphic-1',
        label: '图5 Logo',
        role: 'logo',
        textValue: null,
        sourceUrl: 'data:image/png;base64,AA==',
        recolorMaskUrl: 'data:image/png;base64,AQ==',
        x: 512,
        y: 512,
        width: 300,
        height: 100,
        rotation: 0,
        recolor: { mode: 'original', color: null },
      },
      styledTexts: [
        { id: 'text-1', value: '研', sourceUrl: 'data:image/png;base64,Ag==', recolorMaskUrl: 'data:image/png;base64,Aw==', width: 120, height: 180 },
        { id: 'text-2', value: '2026', sourceUrl: 'data:image/png;base64,BA==', recolorMaskUrl: 'data:image/png;base64,BQ==', width: 300, height: 120 },
      ],
      sequence: [
        { kind: 'text', id: 'text-1' },
        { kind: 'graphic', label: '图5' },
        { kind: 'text', id: 'text-2' },
      ],
      preprocessing: {
        qualityScore: 60,
        blurScore: 60,
        enhancement: 'professional',
        backgroundRemoval: 'edge-connected',
        processingRoute: 'hybrid',
      },
    });

    expect(draft.extraGraphics).toHaveLength(2);
    expect(draft.extraGraphics?.map((graphic) => graphic.textValue)).toEqual(['研', '2026']);
    expect(artworkDraftExactText(draft)).toBe('研 2026');
    expect(() => assertArtworkDraft(draft)).not.toThrow();
  });
});

describe('artwork text deformation', () => {
  it.each([
    ['圆弧形文字“小景是牙医”，文字下面组合图1', '小景是牙医', 'up', 'verticalReverse'],
    ['文字“小景是牙医”排成圆弧形，置于牙齿图形上方', '小景是牙医', 'up', 'verticalReverse'],
    ['文字排成下弧，图上字下', '牙医', 'down', 'vertical'],
    ['文字沿弧排列，字上图下', '牙医', 'up', 'verticalReverse'],
    ['文字做扇形，字左图右', '牙医', 'up', 'horizontalReverse'],
    ['弧形', '牙医', 'up', 'vertical'],
    ['牙齿图案外轮廓为弧形，下方添加文字', '牙医', 'none', 'vertical'],
    ['保留弧形轮廓并添加文字', '牙医', 'none', 'vertical'],
    ['文字不要弧形，改为直排', '牙医', 'none', 'vertical'],
    ['文字不要直排，改为圆弧形', '牙医', 'up', 'vertical'],
    ['文字“弧形艺术”', '弧形艺术', 'none', 'vertical'],
  ])('interprets text geometry without confusing copy or logo shapes: %s', (requirement, exactText, arc, layout) => {
    expect(inferredArtworkTextArc(requirement, exactText).mode).toBe(arc);
    expect(inferredArtworkLayout(requirement, exactText)).toBe(layout);
  });

  it('lays out multiline copy on separate baselines with per-line alignment and measured widths', () => {
    const text = addArtworkText(createLegacyArtworkDraft('/old.png'), { x: 512, y: 512 }).draft.text!;
    Object.assign(text, { value: 'AB\r\nC', fontSize: 40, lineHeight: 1.5, boxWidth: 200, letterSpacing: 0, align: 'left' });
    const glyphs = artworkTextGlyphLayout(text, [20, 30, 40]);
    expect(glyphs.map(g => g.char)).toEqual(['A', 'B', 'C']);
    expect(glyphs.map(g => g.y)).toEqual([-30, -30, 30]);
    expect(glyphs[0].x - glyphs[0].advance / 2).toBe(-100);
    expect(glyphs[2].x - glyphs[2].advance / 2).toBe(-100);
    text.align = 'right';
    const right = artworkTextGlyphLayout(text, [20, 30, 40]);
    expect(right[1].x + right[1].advance / 2).toBe(100);
    expect(right[2].x + right[2].advance / 2).toBe(100);
  });
  it('preserves blank lines and stored line breaks when switching to an arc and back', () => {
    const text = addArtworkText(createLegacyArtworkDraft('/old.png'), { x: 512, y: 512 }).draft.text!;
    Object.assign(text, { value: '研\n\n2026', fontSize: 40, lineHeight: 2 });
    const straight = artworkTextGlyphLayout(text);
    expect(straight[0].y).toBe(-80);
    expect(straight.at(-1)!.y).toBe(80);
    text.arc.mode = 'up';
    expect(artworkTextGlyphLayout(text).map(g => g.char).join('')).toBe('研  2026');
    expect(text.value).toBe('研\n\n2026');
    text.arc.mode = 'none';
    expect(artworkTextGlyphLayout(text)).toEqual(straight);
    expect(() => assertArtworkDraft({ ...addArtworkText(createLegacyArtworkDraft('/old.png'), { x: 0, y: 0 }).draft, text: { ...text, lineHeight: 0 } })).toThrow('lineHeight');
  });
  it('uses the same deterministic geometry for upward and downward arcs', () => {
    const upward = arcGlyphTransforms('汉方嘉铁', 80, 2, 600, 'up', 70);
    const downward = arcGlyphTransforms('汉方嘉铁', 80, 2, 600, 'down', 70);

    expect(upward).toHaveLength(4);
    expect(upward[1].y).toBeLessThan(0);
    expect(downward[1].y).toBeGreaterThan(0);
    expect(Math.abs(upward[1].y)).toBeCloseTo(Math.abs(downward[1].y));
    expect(upward.map((glyph) => glyph.x)).toEqual(downward.map((glyph) => glyph.x));
    expect(upward[0].rotation).toBeLessThan(0);
    expect(upward.at(-1)!.rotation).toBeGreaterThan(0);
    expect(downward[0].rotation).toBeGreaterThan(0);
    expect(downward.at(-1)!.rotation).toBeLessThan(0);
    const middleSlope = (upward[2].y - upward[0].y) / (upward[2].x - upward[0].x);
    expect(Math.tan(upward[1].rotation * Math.PI / 180)).toBeCloseTo(middleSlope);
  });

  it('preserves the font proportions when text exceeds its alignment box', () => {
    const glyphs = arcGlyphTransforms('VERY-LONG-ENGLISH-TEXT-2026', 80, 4, 320, 'none', 0);
    expect(glyphs.every(glyph => glyph.horizontalScale === 1)).toBe(true);
    expect(glyphs.at(-1)!.x - glyphs[0].x).toBeGreaterThan(320);
  });
});

describe('artwork smart snapping', () => {
  it('snaps to the canvas center inside the threshold', () => {
    const result = snapArtworkPosition({
      rawX: 518,
      rawY: 507,
      movingWidth: 200,
      movingHeight: 180,
      otherBounds: null,
      threshold: 8,
      enabled: true,
    });

    expect(result.x).toBe(512);
    expect(result.y).toBe(512);
    expect(result.guides.map((guide) => guide.label)).toEqual([
      '画布垂直中心',
      '画布水平中心',
    ]);
  });

  it('snaps an edge and center to the other layer', () => {
    const result = snapArtworkPosition({
      rawX: 305,
      rawY: 416,
      movingWidth: 200,
      movingHeight: 120,
      otherBounds: { left: 200, top: 300, width: 210, height: 240 },
      threshold: 8,
      enabled: true,
    });

    expect(result.x).toBe(305);
    expect(result.y).toBe(420);
    expect(result.guides.some((guide) => guide.label === '另一图层水平中心')).toBe(true);
    expect(result.guides.some((guide) => guide.label === '另一图层垂直中心')).toBe(true);
  });

  it('does not change coordinates when snapping is disabled', () => {
    expect(snapArtworkPosition({
      rawX: 518,
      rawY: 507,
      movingWidth: 200,
      movingHeight: 180,
      otherBounds: null,
      threshold: 8,
      enabled: false,
    })).toEqual({ x: 518, y: 507, guides: [] });
  });
});

describe('artwork transparent output bounds', () => {
  it('finds the non-transparent content so exported PNG can remove empty canvas', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels[(1 * 4 + 2) * 4 + 3] = 255;
    pixels[(2 * 4 + 3) * 4 + 3] = 128;

    expect(alphaContentBounds(pixels, 4, 4)).toEqual({
      left: 2,
      top: 1,
      right: 3,
      bottom: 2,
    });
  });
});
