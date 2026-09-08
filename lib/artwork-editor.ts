import type { ArtworkRoutingReport } from '@/lib/artwork-routing-standard';

export const ARTWORK_CANVAS_SIZE = 1024;
export const ARTWORK_SNAP_SCREEN_PX = 8;

export type ArtworkLayoutPreset = 'vertical' | 'horizontal' | 'horizontalReverse' | 'custom';
export type ArtworkAlignment = 'left' | 'center' | 'right';
export type ArtworkArcMode = 'none' | 'up' | 'down';

export type ArtworkGraphicLayer = {
  id?: string;
  label?: string;
  visible?: boolean;
  recolorScope?: 'subject' | 'visible';
  role?: 'logo' | 'styledText' | 'decoration';
  textValue?: string | null;
  sourceUrl: string;
  /** Editable bounds inside the native raster; retain its full pixel grid for export sampling. */
  sourceBounds?: ArtworkBounds;
  /** Outward ink expansion in artwork coordinates; source pixels remain unchanged. */
  inkSpread?: number;
  recolorMaskUrl?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  recolor: {
    mode: 'original' | 'solid';
    color: string | null;
  };
};

export type ArtworkTextLayer = {
  id?: string;
  label?: string;
  visible?: boolean;
  value: string;
  x: number;
  y: number;
  boxWidth: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  letterSpacing: number;
  /** Baseline distance as a multiple of font size; absent on older single-line drafts. */
  lineHeight?: number;
  fontWeight: 400 | 500 | 600 | 700 | 800;
  italic: boolean;
  underline: boolean;
  align: ArtworkAlignment;
  arc: {
    mode: ArtworkArcMode;
    bend: number;
  };
};

export type ArtworkDraft = {
  version: 1;
  mode: 'structured' | 'legacyFlattened' | 'pixelLayers';
  /** Stable layer IDs in paint order, from bottom to top. Absent on older drafts. */
  layerOrder?: string[];
  canvas: {
    width: typeof ARTWORK_CANVAS_SIZE;
    height: typeof ARTWORK_CANVAS_SIZE;
  };
  graphic: ArtworkGraphicLayer;
  extraGraphics?: ArtworkGraphicLayer[];
  text: ArtworkTextLayer | null;
  extraTexts?: ArtworkTextLayer[];
  layout: {
    preset: ArtworkLayoutPreset;
    gap: number;
    groupAlign: ArtworkAlignment;
  };
  preprocessing: {
    cutout?: import('@/lib/artwork-cutout').ArtworkCutoutReceipt;
    cutoutRuns?: import('@/lib/artwork-cutout').ArtworkCutoutReceipt[];
    edgeRefinement?: string;
    routingReport?: ArtworkRoutingReport;
    qualityScore: number | null;
    blurScore: number | null;
    enhancement: 'none' | 'standard' | 'professional';
    backgroundRemoval: 'none' | 'edge-connected' | 'product' | 'general';
    sourceKind?: 'transparent' | 'flat-background' | 'uncertain-background' | 'complex-background';
    qualityLevel?: 'usable' | 'low' | 'severe';
    subjectWidth?: number;
    subjectHeight?: number;
    requiredScale?: number;
    processingRoute?: 'fidelity' | 'hybrid' | 'model';
    routeReasons?: string[];
    routeOverride?: boolean;
    generationModel?: string | null;
    componentSummary?: string[];
    resolvedPrompt?: string | null;
    promptVersion?: string | null;
    promptHash?: string | null;
    imageMapping?: Array<{
      sourceLabel: string;
      modelInputLabel: string;
      role: 'content' | 'reference';
      requirement: string;
    }>;
  };
};

export type ArtworkBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function artworkGraphicBounds(graphic: ArtworkGraphicLayer): ArtworkBounds {
  const angle = graphic.rotation * Math.PI / 180;
  const frame = artworkGraphicFrame(graphic);
  const width = Math.abs(frame.width * Math.cos(angle)) + Math.abs(frame.height * Math.sin(angle));
  const height = Math.abs(frame.width * Math.sin(angle)) + Math.abs(frame.height * Math.cos(angle));
  return { left: graphic.x - width / 2, top: graphic.y - height / 2, width, height };
}

/** Unrotated painted frame, also used for alpha hit testing and selection. */
export function artworkGraphicFrame(graphic: ArtworkGraphicLayer): ArtworkBounds {
  const spread = graphic.inkSpread ?? 0;
  return { left: graphic.x - graphic.width / 2 - spread, top: graphic.y - graphic.height / 2 - spread,
    width: graphic.width + spread * 2, height: graphic.height + spread * 2 };
}

/** Keep the original coordinate system; grow the working surface around visible content. */
export function artworkCanvasBounds(content: ArtworkBounds[]): ArtworkBounds {
  const margin = 28;
  const left = Math.floor(Math.min(0, ...content.map(b => b.left - margin)));
  const top = Math.floor(Math.min(0, ...content.map(b => b.top - margin)));
  const right = Math.ceil(Math.max(ARTWORK_CANVAS_SIZE, ...content.map(b => b.left + b.width + margin)));
  const bottom = Math.ceil(Math.max(ARTWORK_CANVAS_SIZE, ...content.map(b => b.top + b.height + margin)));
  return { left, top, width: right - left, height: bottom - top };
}

export type ArtworkSnapGuide = {
  axis: 'x' | 'y';
  position: number;
  label: string;
  distance: number;
};

export type ArtworkSnapResult = {
  x: number;
  y: number;
  guides: ArtworkSnapGuide[];
};

export type ArcGlyphTransform = {
  char: string;
  x: number;
  y: number;
  rotation: number;
  advance: number;
  horizontalScale: number;
};

const COLOR_KEYWORDS: Array<[string, string]> = [
  ['墨绿', '#18583f'],
  ['深绿', '#176b49'],
  ['绿色', '#177a4b'],
  ['深蓝', '#173f82'],
  ['藏蓝', '#173f82'],
  ['蓝色', '#1769aa'],
  ['大红', '#d7251d'],
  ['红色', '#d7251d'],
  ['金色', '#b78326'],
  ['黄色', '#f0b429'],
  ['橙色', '#e87925'],
  ['玫红', '#c92f71'],
  ['粉色', '#dc7a9f'],
  ['紫色', '#7353a6'],
  ['灰色', '#687078'],
  ['白色', '#ffffff'],
  ['黑色', '#111827'],
];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function numeric(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${field} 必须在 ${minimum}–${maximum} 之间，实际为 ${String(value)}`);
  }
  return value;
}

function color(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new Error(`${field} 必须是 #RRGGBB 颜色，实际为 ${String(value)}`);
  }
  return value.toLowerCase();
}

export function inferredArtworkColor(text: string, fallback: string) {
  const normalized = text.replace(/\s+/gu, '');
  return COLOR_KEYWORDS.find(([keyword]) => normalized.includes(keyword))?.[1] ?? fallback;
}

function requestedArtworkColor(text: string) {
  return text.match(/#[0-9a-f]{6}\b/iu)?.[0] ?? (inferredArtworkColor(text, '') || null);
}

export function inferredArtworkLayout(text: string): ArtworkLayoutPreset {
  const normalized = text.replace(/\s+/gu, '');
  if (/(?:文字|字)在左|(?:文字|字)左(?:图|图形|logo)/iu.test(normalized)) {
    return 'horizontalReverse';
  }
  if (/左右排版|横向排版|并排|图左字右|logo左(?:侧|边).*(?:文字|字)右(?:侧|边)/iu.test(normalized)) {
    return 'horizontal';
  }
  return 'vertical';
}

export function createStructuredArtworkDraft(input: {
  graphicSourceUrl: string;
  recolorMaskUrl?: string | null;
  graphicWidth: number;
  graphicHeight: number;
  exactText: string;
  instruction: string;
  layoutNote: string;
  qualityScore?: number | null;
  blurScore?: number | null;
  enhancement: 'none' | 'standard' | 'professional';
  backgroundRemoval: 'none' | 'edge-connected' | 'product' | 'general';
  sourceKind?: 'transparent' | 'flat-background' | 'uncertain-background' | 'complex-background';
  resolution?: {
    level: 'usable' | 'low' | 'severe';
    subjectWidth: number;
    subjectHeight: number;
    requiredScale: number;
  };
  processingRoute?: 'fidelity' | 'hybrid' | 'model';
  routeReasons?: string[];
  routeOverride?: boolean;
  generationModel?: string | null;
  componentSummary?: string[];
}) : ArtworkDraft {
  if (!input.graphicSourceUrl.trim()) throw new Error('图形图层缺少图片地址');
  numeric(input.graphicWidth, 'graphicWidth', 1, 20_000);
  numeric(input.graphicHeight, 'graphicHeight', 1, 20_000);
  const layoutText = `${input.instruction}\n${input.layoutNote}`;
  const preset = inferredArtworkLayout(layoutText);
  const maximumGraphicWidth = preset === 'vertical' ? 500 : 390;
  const maximumGraphicHeight = preset === 'vertical' ? 500 : 520;
  const graphicScale = Math.min(
    maximumGraphicWidth / input.graphicWidth,
    maximumGraphicHeight / input.graphicHeight,
  );
  const graphicWidth = Math.max(1, Math.round(input.graphicWidth * graphicScale));
  const graphicHeight = Math.max(1, Math.round(input.graphicHeight * graphicScale));
  const textValue = input.exactText.trim();
  const graphicColor = requestedArtworkColor(input.instruction);
  const textColor = requestedArtworkColor(input.layoutNote)
    ?? requestedArtworkColor(input.instruction)
    ?? '#111827';
  const gap = 64;
  const isHorizontal = preset === 'horizontal' || preset === 'horizontalReverse';
  const graphicX = isHorizontal
    ? (preset === 'horizontal' ? 310 : 714)
    : ARTWORK_CANVAS_SIZE / 2;
  const graphicY = isHorizontal ? ARTWORK_CANVAS_SIZE / 2 : 360;
  const textX = isHorizontal
    ? (preset === 'horizontal' ? 700 : 324)
    : ARTWORK_CANVAS_SIZE / 2;
  const textY = isHorizontal ? ARTWORK_CANVAS_SIZE / 2 : 730;

  return {
    version: 1,
    mode: 'structured',
    canvas: { width: ARTWORK_CANVAS_SIZE, height: ARTWORK_CANVAS_SIZE },
    graphic: {
      id: 'graphic-1',
      label: 'Logo 图形',
      role: 'logo',
      textValue: null,
      sourceUrl: input.graphicSourceUrl,
      recolorMaskUrl: input.recolorMaskUrl ?? null,
      x: graphicX,
      y: graphicY,
      width: graphicWidth,
      height: graphicHeight,
      rotation: 0,
      recolor: graphicColor && input.recolorMaskUrl
        ? { mode: 'solid', color: graphicColor }
        : { mode: 'original', color: null },
    },
    text: textValue ? {
      id: 'text-1',
      label: '准确文字',
      value: textValue,
      x: textX,
      y: textY,
      boxWidth: isHorizontal ? 500 : 760,
      fontFamily: 'Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif',
      fontSize: Math.max(20, Math.min(84, Math.round(640 / Math.max([...textValue].length, 5)))),
      color: textColor,
      letterSpacing: 2,
      fontWeight: 700,
      italic: false,
      underline: false,
      align: 'center',
      arc: { mode: 'none', bend: 35 },
    } : null,
    layout: { preset, gap, groupAlign: 'center' },
    preprocessing: {
      qualityScore: input.qualityScore ?? null,
      blurScore: input.blurScore ?? null,
      enhancement: input.enhancement,
      backgroundRemoval: input.backgroundRemoval,
      sourceKind: input.sourceKind,
      qualityLevel: input.resolution?.level,
      subjectWidth: input.resolution?.subjectWidth,
      subjectHeight: input.resolution?.subjectHeight,
      requiredScale: input.resolution?.requiredScale,
      processingRoute: input.processingRoute,
      routeReasons: input.routeReasons,
      routeOverride: input.routeOverride,
      generationModel: input.generationModel ?? null,
      componentSummary: input.componentSummary,
    },
  };
}

export function artworkGraphicLayers(draft: ArtworkDraft) {
  return [draft.graphic, ...(draft.extraGraphics ?? [])];
}

export function artworkTextLayers(draft: ArtworkDraft) {
  return [draft.text, ...(draft.extraTexts ?? [])].filter((text): text is ArtworkTextLayer => text !== null);
}

export function artworkDraftExactText(draft: ArtworkDraft) {
  const values = [
    ...artworkGraphicLayers(draft)
      .filter((graphic) => graphic.visible !== false && graphic.role === 'styledText' && graphic.textValue?.trim())
      .map((graphic) => graphic.textValue?.trim() ?? ''),
    ...artworkTextLayers(draft).filter(text => text.visible !== false).map((text) => text.value.trim()),
  ].filter(Boolean);
  return values.join(' ');
}

export function createHybridArtworkDraft(input: {
  primaryGraphic: ArtworkGraphicLayer;
  styledTexts: Array<{
    id: string;
    value: string;
    sourceUrl: string;
    recolorMaskUrl: string;
    width: number;
    height: number;
  }>;
  sequence: Array<{ kind: 'graphic'; label: string } | { kind: 'text'; id: string }>;
  preprocessing: ArtworkDraft['preprocessing'];
}) : ArtworkDraft {
  if (input.styledTexts.length === 0) throw new Error('混合图案至少需要一个模型文字组件');
  const textById = new Map(input.styledTexts.map((text) => [text.id, text]));
  const sequence = input.sequence.filter((component) => component.kind === 'graphic' || textById.has(component.id));
  if (sequence.length !== input.styledTexts.length + 1) {
    throw new Error(`混合图案组件顺序不完整：预期 ${input.styledTexts.length + 1} 项，实际 ${sequence.length} 项`);
  }
  const step = ARTWORK_CANVAS_SIZE / (sequence.length + 1);
  const positioned = sequence.map((component, index) => {
    const x = step * (index + 1);
    if (component.kind === 'graphic') {
      const scale = Math.min(330 / input.primaryGraphic.width, 430 / input.primaryGraphic.height);
      return {
        ...input.primaryGraphic,
        id: input.primaryGraphic.id ?? 'graphic-1',
        label: input.primaryGraphic.label ?? 'Logo 图形',
        role: 'logo' as const,
        textValue: null,
        x,
        y: ARTWORK_CANVAS_SIZE / 2,
        width: Math.max(1, Math.round(input.primaryGraphic.width * scale)),
        height: Math.max(1, Math.round(input.primaryGraphic.height * scale)),
      };
    }
    const text = textById.get(component.id);
    if (!text) throw new Error(`找不到模型文字组件：${component.id}`);
    const scale = Math.min(230 / text.width, 300 / text.height);
    return {
      id: text.id,
      label: `特殊文字“${text.value}”`,
      role: 'styledText' as const,
      textValue: text.value,
      sourceUrl: text.sourceUrl,
      recolorMaskUrl: text.recolorMaskUrl,
      x,
      y: ARTWORK_CANVAS_SIZE / 2,
      width: Math.max(1, Math.round(text.width * scale)),
      height: Math.max(1, Math.round(text.height * scale)),
      rotation: 0,
      recolor: { mode: 'original' as const, color: null },
    };
  });
  const primaryIndex = sequence.findIndex((component) => component.kind === 'graphic');
  if (primaryIndex < 0) throw new Error('混合图案缺少主要图形组件');
  const primaryGraphic = positioned[primaryIndex];
  return {
    version: 1,
    mode: 'structured',
    canvas: { width: ARTWORK_CANVAS_SIZE, height: ARTWORK_CANVAS_SIZE },
    graphic: primaryGraphic,
    extraGraphics: positioned.filter((_, index) => index !== primaryIndex),
    text: null,
    layout: { preset: 'custom', gap: 48, groupAlign: 'center' },
    preprocessing: input.preprocessing,
  };
}

export function createLegacyArtworkDraft(sourceUrl: string): ArtworkDraft {
  if (!sourceUrl.trim()) throw new Error('旧版合并图缺少图片地址');
  return {
    version: 1,
    mode: 'legacyFlattened',
    canvas: { width: ARTWORK_CANVAS_SIZE, height: ARTWORK_CANVAS_SIZE },
    graphic: {
      id: 'graphic-1',
      label: '合并图案',
      role: 'logo',
      textValue: null,
      sourceUrl,
      recolorMaskUrl: null,
      x: ARTWORK_CANVAS_SIZE / 2,
      y: ARTWORK_CANVAS_SIZE / 2,
      width: 760,
      height: 760,
      rotation: 0,
      recolor: { mode: 'original', color: null },
    },
    text: null,
    layout: { preset: 'custom', gap: 0, groupAlign: 'center' },
    preprocessing: {
      qualityScore: null,
      blurScore: null,
      enhancement: 'none',
      backgroundRemoval: 'none',
    },
  };
}

export function assertArtworkDraft(value: unknown): asserts value is ArtworkDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('artworkDraft 必须是对象');
  const draft = value as Record<string, unknown>;
  if (draft.version !== 1) throw new Error(`artworkDraft.version 仅支持 1，实际为 ${String(draft.version)}`);
  if (draft.mode !== 'structured' && draft.mode !== 'legacyFlattened' && draft.mode !== 'pixelLayers') {
    throw new Error(`artworkDraft.mode 不支持：${String(draft.mode)}`);
  }
  const validateGraphic = (graphicValue: unknown, field: string) => {
    if (!graphicValue || typeof graphicValue !== 'object' || Array.isArray(graphicValue)) {
      throw new Error(`${field} 必须是对象`);
    }
    const graphic = graphicValue as Record<string, unknown>;
    if (graphic.inkSpread !== undefined) numeric(graphic.inkSpread, `${field}.inkSpread`, 0, 3);
    if (graphic.sourceBounds !== undefined) {
      const bounds = graphic.sourceBounds as Record<string, unknown>;
      if (!bounds || typeof bounds !== 'object') throw new Error(`${field}.sourceBounds 无效`);
      numeric(bounds.left, `${field}.sourceBounds.left`, 0, 20_000);
      numeric(bounds.top, `${field}.sourceBounds.top`, 0, 20_000);
      numeric(bounds.width, `${field}.sourceBounds.width`, 1, 20_000);
      numeric(bounds.height, `${field}.sourceBounds.height`, 1, 20_000);
    }
    if (graphic.visible !== undefined && typeof graphic.visible !== 'boolean') throw new Error(`${field}.visible 必须是布尔值`);
    if (graphic.recolorScope !== undefined && graphic.recolorScope !== 'subject' && graphic.recolorScope !== 'visible') throw new Error(`${field}.recolorScope 无效`);
  if (typeof graphic.sourceUrl !== 'string' || !graphic.sourceUrl.trim()) {
      throw new Error(`${field}.sourceUrl 必须是非空地址`);
  }
  if (graphic.recolorMaskUrl !== undefined
    && graphic.recolorMaskUrl !== null
    && (typeof graphic.recolorMaskUrl !== 'string' || !graphic.recolorMaskUrl.trim())) {
      throw new Error(`${field}.recolorMaskUrl 必须是非空地址或 null`);
  }
    numeric(graphic.x, `${field}.x`, -ARTWORK_CANVAS_SIZE, ARTWORK_CANVAS_SIZE * 2);
    numeric(graphic.y, `${field}.y`, -ARTWORK_CANVAS_SIZE, ARTWORK_CANVAS_SIZE * 2);
    numeric(graphic.width, `${field}.width`, .001, ARTWORK_CANVAS_SIZE * 2);
    numeric(graphic.height, `${field}.height`, .001, ARTWORK_CANVAS_SIZE * 2);
    numeric(graphic.rotation, `${field}.rotation`, -360, 360);
  };
  validateGraphic(draft.graphic, 'artworkDraft.graphic');
  if (draft.extraGraphics !== undefined) {
    if (!Array.isArray(draft.extraGraphics)) throw new Error('artworkDraft.extraGraphics 必须是数组');
    draft.extraGraphics.forEach((graphic, index) => validateGraphic(graphic, `artworkDraft.extraGraphics[${index}]`));
  }
  if (draft.mode === 'legacyFlattened' && (
    draft.text !== null
    || (Array.isArray(draft.extraGraphics) && draft.extraGraphics.length > 0)
    || (Array.isArray(draft.extraTexts) && draft.extraTexts.length > 0)
  )) {
    throw new Error('旧版合并图不能伪造独立图形或文字图层');
  }
  const validateText = (textValue: unknown, field: string) => {
    if (!textValue || typeof textValue !== 'object' || Array.isArray(textValue)) {
      throw new Error(`${field} 必须是对象`);
    }
    const text = textValue as Record<string, unknown>;
    if (text.visible !== undefined && typeof text.visible !== 'boolean') throw new Error(`${field}.visible 必须是布尔值`);
    if (typeof text.value !== 'string' || !text.value.trim()) throw new Error(`${field}.value 不能为空`);
    numeric(text.x, `${field}.x`, -ARTWORK_CANVAS_SIZE, ARTWORK_CANVAS_SIZE * 2);
    numeric(text.y, `${field}.y`, -ARTWORK_CANVAS_SIZE, ARTWORK_CANVAS_SIZE * 2);
    numeric(text.fontSize, `${field}.fontSize`, 8, 300);
    numeric(text.boxWidth, `${field}.boxWidth`, 20, ARTWORK_CANVAS_SIZE * 2);
    numeric(text.letterSpacing, `${field}.letterSpacing`, -20, 80);
    if (text.lineHeight !== undefined) numeric(text.lineHeight, `${field}.lineHeight`, 1, 3);
    color(text.color, `${field}.color`);
  };
  if (draft.text !== null) validateText(draft.text, 'artworkDraft.text');
  if (draft.extraTexts !== undefined) {
    if (!Array.isArray(draft.extraTexts)) throw new Error('artworkDraft.extraTexts 必须是数组');
    draft.extraTexts.forEach((text, index) => validateText(text, `artworkDraft.extraTexts[${index}]`));
  }
  if (draft.layerOrder !== undefined) {
    const layers = [...artworkGraphicLayers(value as ArtworkDraft), ...artworkTextLayers(value as ArtworkDraft)];
    const ids = layers.map(layer => layer.id);
    if (layers.length > 64) throw new Error('最多支持 64 个图层');
    if (!Array.isArray(draft.layerOrder) || draft.layerOrder.length !== ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length || new Set(draft.layerOrder).size !== ids.length || draft.layerOrder.some(id => !ids.includes(id))) throw new Error('图层顺序必须完整且不能重复');
  }
}

function glyphAdvance(char: string, fontSize: number, letterSpacing: number) {
  const characterWidth = /[\u0000-\u00ff]/u.test(char) ? fontSize * 0.58 : fontSize;
  return Math.max(1, characterWidth + letterSpacing);
}

export function arcGlyphTransforms(
  text: string,
  fontSize: number,
  letterSpacing: number,
  boxWidth: number,
  arcMode: ArtworkArcMode,
  bend: number,
  measuredWidths?: number[],
): ArcGlyphTransform[] {
  if (!text) return [];
  // boxWidth is an alignment reference, never a reason to squash letters.
  if (!Number.isFinite(boxWidth) || boxWidth <= 0) throw new Error(`文字对齐宽度无效：${boxWidth}`);
  if (measuredWidths && (measuredWidths.length !== [...text].length || measuredWidths.some(width => !Number.isFinite(width) || width < 0))) throw new Error(`文字测量宽度无效：${JSON.stringify(measuredWidths)}`);
  const advances = [...text].map((char, index) => measuredWidths ? Math.max(1, measuredWidths[index] + letterSpacing) : glyphAdvance(char, fontSize, letterSpacing));
  const totalWidth = advances.reduce((total, advance) => total + advance, 0);
  const amplitude = clamp(bend, 0, 100) / 100 * fontSize * 1.45;
  let cursor = -totalWidth / 2;
  return [...text].map((char, index) => {
    const advance = advances[index];
    const x = cursor + advance / 2;
    cursor += advance;
    if (arcMode === 'none') return { char, x, y: 0, rotation: 0, advance, horizontalScale: 1 };
    const normalizedX = clamp(x / Math.max(totalWidth / 2, 1), -1, 1);
    const direction = arcMode === 'up' ? -1 : 1;
    return {
      char,
      x,
      y: direction * amplitude * (1 - normalizedX ** 2),
      rotation: direction * normalizedX * clamp(bend, 0, 100) * 0.32,
      advance,
      horizontalScale: 1,
    };
  });
}

/** Newlines create independent baselines; arc mode displays one line without changing the stored copy. */
export function artworkTextGlyphLayout(text: ArtworkTextLayer, measuredWidths?: number[]) {
  const value = text.value.replace(/\r\n?/gu, '\n');
  const lines = text.arc.mode === 'none' ? value.split('\n') : [value.replace(/\n/gu, ' ')];
  let offset = 0;
  return lines.flatMap((line, index) => {
    const length = [...line].length;
    const glyphs = arcGlyphTransforms(line, text.fontSize, text.letterSpacing, text.boxWidth, text.arc.mode, text.arc.bend, measuredWidths?.slice(offset, offset + length));
    offset += length;
    const width = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
    const x = text.align === 'left' ? (width - text.boxWidth) / 2 : text.align === 'right' ? (text.boxWidth - width) / 2 : 0;
    const y = (index - (lines.length - 1) / 2) * text.fontSize * (text.lineHeight ?? 1.4);
    return glyphs.map(glyph => ({ ...glyph, x: glyph.x + x, y: glyph.y + y }));
  });
}

function closestGuide(candidates: ArtworkSnapGuide[], threshold: number) {
  return candidates
    .filter((candidate) => candidate.distance <= threshold)
    .sort((left, right) => left.distance - right.distance)[0] ?? null;
}

export function snapArtworkPosition(input: {
  rawX: number;
  rawY: number;
  movingWidth: number;
  movingHeight: number;
  otherBounds: ArtworkBounds | null;
  canvasWidth?: number;
  canvasHeight?: number;
  threshold: number;
  enabled: boolean;
}): ArtworkSnapResult {
  if (!input.enabled) return { x: input.rawX, y: input.rawY, guides: [] };
  const canvasWidth = input.canvasWidth ?? ARTWORK_CANVAS_SIZE;
  const canvasHeight = input.canvasHeight ?? ARTWORK_CANVAS_SIZE;
  const movingLeft = input.rawX - input.movingWidth / 2;
  const movingRight = input.rawX + input.movingWidth / 2;
  const movingTop = input.rawY - input.movingHeight / 2;
  const movingBottom = input.rawY + input.movingHeight / 2;
  const xCandidates: Array<ArtworkSnapGuide & { corrected: number }> = [
    {
      axis: 'x', position: canvasWidth / 2, label: '画布垂直中心',
      distance: Math.abs(input.rawX - canvasWidth / 2), corrected: canvasWidth / 2,
    },
  ];
  const yCandidates: Array<ArtworkSnapGuide & { corrected: number }> = [
    {
      axis: 'y', position: canvasHeight / 2, label: '画布水平中心',
      distance: Math.abs(input.rawY - canvasHeight / 2), corrected: canvasHeight / 2,
    },
  ];
  if (input.otherBounds) {
    const other = input.otherBounds;
    const otherRight = other.left + other.width;
    const otherBottom = other.top + other.height;
    const otherCenterX = other.left + other.width / 2;
    const otherCenterY = other.top + other.height / 2;
    xCandidates.push(
      { axis: 'x', position: other.left, label: '另一图层左边缘', distance: Math.abs(movingLeft - other.left), corrected: other.left + input.movingWidth / 2 },
      { axis: 'x', position: otherCenterX, label: '另一图层水平中心', distance: Math.abs(input.rawX - otherCenterX), corrected: otherCenterX },
      { axis: 'x', position: otherRight, label: '另一图层右边缘', distance: Math.abs(movingRight - otherRight), corrected: otherRight - input.movingWidth / 2 },
    );
    yCandidates.push(
      { axis: 'y', position: other.top, label: '另一图层上边缘', distance: Math.abs(movingTop - other.top), corrected: other.top + input.movingHeight / 2 },
      { axis: 'y', position: otherCenterY, label: '另一图层垂直中心', distance: Math.abs(input.rawY - otherCenterY), corrected: otherCenterY },
      { axis: 'y', position: otherBottom, label: '另一图层下边缘', distance: Math.abs(movingBottom - otherBottom), corrected: otherBottom - input.movingHeight / 2 },
    );
  }
  const xGuide = closestGuide(xCandidates, input.threshold) as (ArtworkSnapGuide & { corrected: number }) | null;
  const yGuide = closestGuide(yCandidates, input.threshold) as (ArtworkSnapGuide & { corrected: number }) | null;
  return {
    x: xGuide?.corrected ?? input.rawX,
    y: yGuide?.corrected ?? input.rawY,
    guides: [xGuide, yGuide].filter((guide): guide is ArtworkSnapGuide & { corrected: number } => guide !== null)
      .map((guide) => ({
        axis: guide.axis,
        position: guide.position,
        label: guide.label,
        distance: guide.distance,
      })),
  };
}
