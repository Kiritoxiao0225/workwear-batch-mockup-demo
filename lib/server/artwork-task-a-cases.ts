/** Shared actual-pixel assertions. Vitest runs these normally; the delivery's
 * offline runner can execute the same bodies without pretending to be Vitest. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { artworkBackgroundContract } from '@/lib/artwork-background-contract';
import { artworkProtectionPolicy } from '@/lib/artwork-protection';
import { validateCutoutOutput, ArtworkCutoutContentError, ArtworkCutoutGeometryError } from './artwork-cutout-analysis';
import { inspectArtworkSource, alphaMaskReport, assertUsableArtworkMask, applyArtworkAlphaMask } from './artwork-image-processing';
import { inspectArtworkCompleteness } from './artwork-foreground-integrity';
import { recolorArtworkPixels, pixelRecolorTarget } from './artwork-pixel-recolor';
import { protectArtworkBadges } from './artwork-badge-protection';
import { protectExplicitArtwork } from './artwork-explicit-protection';
import { assertArtworkMask, redPanelSilhouettes } from './artwork-panel-mask';
import { compositeArtworkLocalEdit, eraseDetachedArtwork, validateLocalEditPlan, type ArtworkLocalEditPlan } from './artwork-local-edit';

const fixture = (name: string) => readFileSync(path.join(process.cwd(), 'lib/server/artwork-task-a-fixtures', name));
const raw = (bytes: Buffer) => sharp(bytes).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
const png = (data: Buffer, width: number, height: number) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
const svg = (content: string, w = 400, h = 400, bg = '') => sharp(Buffer.from(`<svg width="${w}" height="${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${content}</svg>`)).png().toBuffer();
const at = (x: number, y: number, w: number) => (y * w + x) * 4;
const located = (regions: ArtworkLocalEditPlan['regions']): ArtworkLocalEditPlan => ({ status: 'located', regions, evidence: 'test: explicitly supplied pixel target' });

async function roundedPanel(opaqueCorners = false, soft = false) {
  const w = 300, h = 180, r = 24, data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x < r ? r - .5 - x : x >= w - r ? x - (w - r - .5) : 0;
    const dy = y < r ? r - .5 - y : y >= h - r ? y - (h - r - .5) : 0;
    const inside = !dx || !dy || dx * dx + dy * dy <= r * r;
    const letter = inside && x >= 115 && x < 123 && y >= 70 && y < 100;
    const i = at(x, y, w);
    data[i] = inside && !letter ? 220 : 255; data[i + 1] = inside && !letter ? 25 : 255; data[i + 2] = inside && !letter ? 35 : 255;
    data[i + 3] = inside ? soft ? 130 : 255 : opaqueCorners ? 255 : 0;
  }
  return png(data, w, h);
}

export const taskAPixelCases: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'P real regression: occupied perimeter no longer disables missing-left-panel detection', run: async () => {
    const source = fixture('P-cutout-input.png'), output = fixture('P-after-cutout.png');
    const profile = await inspectArtworkSource(source);
    assert.ok(profile.dominantBorderRatio < .95);
    const { data, info } = await raw(output);
    for (let y = 0; y < info.height; y++) for (let x = 0; x < 535; x++) assert.equal(data[at(x, y, info.width) + 3], 0);
    await assert.rejects(validateCutoutOutput(output, source), (error: unknown) => error instanceof ArtworkCutoutContentError && error.missingRegions.some(r => r.left === 0 && r.width >= 530));
  } },
  { name: 'P loss is not excused by an unavailable or implausibly large watermark verdict', run: async () => {
    const source = fixture('P-cutout-input.png'), output = fixture('P-after-cutout.png');
    await assert.rejects(validateCutoutOutput(output, source, { inspectWatermarks: async () => { throw new Error('offline inspection unavailable'); } }), ArtworkCutoutContentError);
    await assert.rejects(validateCutoutOutput(output, source, { inspectWatermarks: async () => [{ bounds: { left: 0, top: 0, width: 2170, height: 725 }, text: 'not proof', model: 'test' }] }), ArtworkCutoutContentError);
  } },
  { name: 'nonuniform planar background + boundary foreground: intact passes, detached fine lines lost fail', run: async () => {
    const w = 240, h = 160, a = Buffer.alloc(w * h * 4), b = Buffer.alloc(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = at(x, y, w), fg = x < 52 && y > 40 && y < 130 || x >= 120 && x < 122 && y > 60 && y < 125 || x >= 155 && x < 172 && y > 100 && y < 102;
      const bg = Math.round(70 + x / w * 45 + y / h * 20);
      a[i] = a[i + 1] = a[i + 2] = fg ? 255 : bg; a[i + 3] = 255;
      b[i] = b[i + 1] = b[i + 2] = 255; b[i + 3] = fg ? 255 : 0;
    }
    const source = await png(a, w, h), intact = await png(b, w, h);
    await validateCutoutOutput(intact, source);
    for (let y = 0; y < h; y++) for (let x = 100; x < w; x++) b[at(x, y, w) + 3] = 0;
    await assert.rejects(validateCutoutOutput(await png(b, w, h), source), ArtworkCutoutContentError);
  } },
  { name: 'unsupported textured boundary is explicitly uncertain, never silently certified', run: async () => {
    const w = 192, h = 144, a = Buffer.alloc(w * h * 4), b = Buffer.alloc(a.length);
    let seed = 123;
    for (let i = 0; i < a.length; i += 4) { for (let c = 0; c < 3; c++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; a[i + c] = seed >>> 24; } a[i + 3] = 255; }
    for (let y = 45; y < 100; y++) for (let x = 45; x < 140; x++) b[at(x, y, w) + 3] = 255;
    const source = await png(a, w, h), output = await png(b, w, h);
    assert.equal((await inspectArtworkCompleteness(source, output)).status, 'uncertain');
    const checked = await validateCutoutOutput(output, source);
    assert.equal(checked.integrity.status, 'uncertain');
    assert.ok(checked.integrity.warning);
    assert.deepEqual(checked.watermarks, []);
  } },
  { name: 'source alpha: filled negative holes / newly added outlines fail geometrically', run: async () => {
    const source = await svg('<path fill="#663399" fill-rule="evenodd" d="M80 80h200v200H80z M120 120h30v80h-30z"/>');
    const { data, info } = await raw(source); for (let y = 125; y < 190; y++) for (let x = 125; x < 145; x++) data[at(x, y, info.width) + 3] = 255;
    await assert.rejects(validateCutoutOutput(await png(data, info.width, info.height), source), ArtworkCutoutGeometryError);
  } },
  { name: 'embedded white text is checked independently of its connected opaque coloured panel', run: async () => {
    const source = await svg('<rect x="80" y="80" width="200" height="200" fill="#cc2020"/><rect x="170" y="175" width="3" height="6" fill="white"/>');
    const { data, info } = await raw(source); for (let y = 175; y < 181; y++) for (let x = 170; x < 173; x++) data[at(x, y, info.width) + 3] = 0;
    await assert.rejects(validateCutoutOutput(await png(data, info.width, info.height), source), ArtworkCutoutContentError);
  } },
  { name: 'pure purple-to-white recolour preserves every alpha value, hole and registered-mark component', run: async () => {
    const source = await svg('<path fill="#663399" fill-rule="evenodd" d="M0 70h200v200H0z M50 100h35v90H50z"/><circle cx="300" cy="100" r="12" fill="none" stroke="#663399" stroke-width="1"/><path d="M295 107v-15h6l2 4-3 4 5 7" fill="none" stroke="#663399"/><path d="M230 250h95" stroke="#663399"/>');
    const changed = await recolorArtworkPixels(source, { instruction: '紫色前景改为白色，保持全部负形与原图几何' });
    assert.ok(changed); const a = await raw(source), b = await raw(changed.bytes);
    assert.deepEqual(a.info, b.info);
    for (let i = 0; i < a.data.length; i += 4) {
      assert.equal(b.data[i + 3], a.data[i + 3]);
      if (a.data[i + 3]) assert.deepEqual([...b.data.subarray(i, i + 3)], [255, 255, 255]);
      else assert.ok(a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4)));
    }
    assert.equal((await inspectArtworkCompleteness(source, changed.bytes)).status, 'checked');
  } },
  { name: 'pure recolour does not guess opaque negatives, multi-colour logos, extra text or design edits', run: async () => {
    assert.equal(pixelRecolorTarget({ instruction: '图案不要改为白色' }), null);
    assert.equal(pixelRecolorTarget({ instruction: '图案仅文字改为白色，其他保留原样' }), null);
    const mixed = await svg('<rect x="40" y="40" width="100" height="120" fill="red"/><rect x="180" y="40" width="80" height="120" fill="blue"/>');
    assert.equal(await recolorArtworkPixels(mixed, { instruction: '图案改为白色' }), null);
    assert.equal(await recolorArtworkPixels(await svg('<rect x="80" y="80" width="100" height="100" fill="purple"/>', 400, 400, 'white'), { instruction: '紫色改为白色' }), null);
    for (const extra of [{ exactText: '新增字' }, { instruction: '图案改为白色并重新设计' }, { referenceImages: [{}] }]) assert.equal(await recolorArtworkPixels(mixed, { instruction: '图案改为白色', ...extra }), null);
  } },
  { name: 'alpha transfer never prunes tiny marks, clips low alpha or thickens a registered mark', run: async () => {
    const source = await svg('<rect x="40" y="40" width="220" height="180" fill="black"/>');
    const a = await raw(source);
    for (let x = 0; x < 256; x++) a.data[at(x, 300, 400) + 3] = x;
    a.data[at(320, 330, 400) + 3] = 255; // single-pixel customer mark, formerly an island
    const mask = await png(a.data, 400, 400), output = await applyArtworkAlphaMask(mask, mask, undefined, true), b = await raw(output);
    for (let i = 3; i < a.data.length; i += 4) assert.equal(b.data[i], a.data[i]);
  } },
  { name: 'registered R warning is not proof; actual intact alpha passes and lost R pixels fail', run: async () => {
    const source = await svg('<rect x="50" y="50" width="170" height="170" fill="black"/><circle cx="300" cy="70" r="12" fill="none" stroke="black"/><path d="M295 77v-15h6l2 4-3 4 5 7" fill="none" stroke="black"/>');
    await validateCutoutOutput(source, source);
    const a = await raw(source); for (let y = 62; y <= 77; y++) for (let x = 295; x <= 305; x++) a.data[at(x, y, 400) + 3] = 0;
    await assert.rejects(validateCutoutOutput(await png(a.data, 400, 400), source), ArtworkCutoutContentError);
  } },
  { name: 'TH actual supplier redraw: local edit cannot propagate the new outline outside its ROI', run: async () => {
    const source = fixture('N-before-generation.png'), generated = fixture('N-generated.png');
    const plan = located([{ left: 570, top: 785, width: 100, height: 40 }]);
    const composed = await compositeArtworkLocalEdit(source, generated, plan), a = await raw(source), b = await raw(composed);
    let compared = 0;
    for (let y = 0; y < a.info.height; y++) for (let x = 0; x < a.info.width; x++) {
      if (x >= 570 && x < 670 && y >= 785 && y < 825) continue;
      const i = at(x, y, a.info.width); assert.ok(a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4))); compared++;
    }
    assert.ok(compared > 1_000_000);
  } },
  { name: 'detached lower old lettering is deleted without repainting any other component', run: async () => {
    const source = await svg('<rect x="60" y="50" width="260" height="160" fill="#e22"/><path d="M80 270v30h15v-30z M120 270v30h15v-30z M160 270v30h15v-30z" fill="black"/>');
    const plan = located([{ left: 70, top: 260, width: 120, height: 50 }]);
    const erased = await eraseDetachedArtwork(source, plan); assert.ok(erased);
    const a = await raw(source), b = await raw(erased);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const i = at(x, y, 400), edited = x >= 70 && x < 190 && y >= 260 && y < 310;
      if (edited) assert.equal(b.data[i + 3], 0); else assert.ok(a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4)));
    }
  } },
  { name: 'intersecting main graphic, uncertain target and oversized edit are not silently erased', run: async () => {
    const source = await svg('<rect x="60" y="50" width="260" height="160" fill="black"/>');
    assert.equal(await eraseDetachedArtwork(source, located([{ left: 100, top: 80, width: 40, height: 40 }])), null);
    assert.throws(() => validateLocalEditPlan(located([{ left: 0, top: 0, width: 400, height: 400 }]), 400, 400), /过大/);
    await assert.rejects(compositeArtworkLocalEdit(source, source, { status: 'uncertain', regions: [], evidence: '' }), /未定位/);
    await assert.rejects(compositeArtworkLocalEdit(source, await sharp(source).resize(800, 400).png().toBuffer(), located([{ left: 100, top: 80, width: 40, height: 40 }])), /画布比例/);
  } },
  ...(['all-background', 'exterior', 'legacy', 'ambiguous'] as const).map(scope => ({ name: `badge ${scope}: actual inner/outer RGBA follows the resolved scope`, run: async () => {
    const instructions = { 'all-background': '全部背景去除，圆内也透明，保留白色图形', exterior: '仅去除外围背景，保留徽章底色和白色图形', legacy: '保留原图案', ambiguous: '去除素材白色背景' };
    const contract = artworkBackgroundContract({ instruction: instructions[scope] }); assert.equal(contract.scope, scope);
    const art = '<circle cx="200" cy="210" r="120" fill="none" stroke="#e11" stroke-width="6"/><path d="M170 180h60v60h-60z M190 200h20v20h-20z" fill="#e11" fill-rule="evenodd"/>';
    const source = await svg(art, 400, 400, 'white'), cutout = await svg(art);
    const result = await protectArtworkBadges(source, cutout, contract), output = await raw(result.bytes), a = await raw(source), b = await raw(cutout);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
      const i = at(x, y, 400), d = Math.hypot(x - 200, y - 210);
      if (scope === 'all-background' || d > 125) assert.ok(output.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4)));
      else if (d < 110) assert.ok(output.data.subarray(i, i + 4).equals(a.data.subarray(i, i + 4)));
    }
    assert.equal(result.regions.length, scope === 'all-background' ? 0 : 1);
  } })),
  { name: 'unit background scope outranks contradictory old generated prompt; conflicts remain ambiguous', run: async () => {
    assert.equal(artworkBackgroundContract({ instruction: '全部背景去除，圆内也透明', generationPrompt: '清除图案外围白色背景，保留内部留白' }).scope, 'all-background');
    assert.equal(artworkBackgroundContract({ instruction: '保留徽章底色', generationPrompt: '全部背景去除' }).scope, 'exterior');
    assert.equal(artworkBackgroundContract({ instruction: '保留全部背景', sourceScope: 'wholeImage' }).scope, 'preserve');
    assert.equal(artworkBackgroundContract({ instruction: '全部背景去除，同时保留圆内底色' }).scope, 'ambiguous');
    assert.notEqual(artworkBackgroundContract({ instruction: '不要去除所有背景' }).scope, 'all-background');
  } },
  { name: 'explicit full-bleed rounded panel: below-5% transparency passes only with proven silhouette', run: async () => {
    const source = await roundedPanel(true), result = await roundedPanel();
    const policy = artworkProtectionPolicy('保留红色底形与白字');
    const report = await alphaMaskReport(result); assert.ok(report.transparentRatio > 0 && report.transparentRatio < .05);
    assert.throws(() => assertUsableArtworkMask(report), /不足 5%/);
    assert.equal((await assertArtworkMask(result, policy)).acceptance, 'explicit-full-bleed-panel');
    await validateCutoutOutput(result, source, { protection: policy });
    await assert.rejects(validateCutoutOutput(result, source), /不足 5%/);
  } },
  { name: 'rounded protection restores original white lettering but never paints opaque square corners', run: async () => {
    const source = await roundedPanel(true), invalid = await roundedPanel(false, true), policy = artworkProtectionPolicy('保留红底与白字');
    const rawMask = await alphaMaskReport(invalid); assert.ok(rawMask.softAlphaAmongVisible > .75);
    await assert.rejects(assertArtworkMask(invalid, policy));
    const restored = await protectExplicitArtwork(source, invalid, policy); assert.equal(restored.protectedPanels, 1);
    const a = await raw(source), b = await raw(restored.bytes), panels = redPanelSilhouettes(a.data, a.info.width, a.info.height);
    assert.equal(panels.length, 1);
    for (let y = 0; y < a.info.height; y++) for (let x = 0; x < a.info.width; x++) {
      const i = at(x, y, a.info.width), [left, right] = panels[0].spans[y];
      if (x >= left && x <= right) assert.ok(a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4))); else assert.equal(b.data[i + 3], 0);
    }
    await validateCutoutOutput(restored.bytes, source, { protection: policy });
  } },
  { name: 'full opaque background and full red rectangle cannot claim rounded-panel exception', run: async () => {
    const policy = artworkProtectionPolicy('保留红底与白字');
    await assert.rejects(assertArtworkMask(await roundedPanel(true), policy), /不足 5%/);
    await assert.rejects(assertArtworkMask(await svg('', 300, 180, '#cc2222'), policy), /不足 5%/);
  } },
];
