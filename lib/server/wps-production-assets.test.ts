import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import {
  attachProductionArtwork,
  confirmProductionArtwork,
  confirmProductionPlan,
  emptyWpsProductionState,
  importTaskReviews,
  markVersionComposing,
  placeProductionArtwork,
} from '@/lib/wps-production';
import { composeProductionMockup, renderProductionPreview, renderProductionMockup, validateProductionArtwork } from '@/lib/server/wps-production-assets';
import { CONFIRMATION_FRAME, CONFIRMATION_OUTPUT } from '@/lib/confirmation-frame';
import { placementPreview } from '@/lib/production-preview';

const createdFiles: string[] = [];
const logoDirectory = path.join(process.cwd(), 'public', 'uploads', 'logos');
const mockupDirectory = path.join(process.cwd(), 'public', 'uploads', 'mockups');

afterEach(async () => {
  await Promise.all(createdFiles.splice(0).map((filePath) => unlink(filePath).catch(() => undefined)));
});

async function saveTestLogo(opaque: boolean) {
  await mkdir(logoDirectory, { recursive: true });
  const name = `production-test-${randomUUID()}.png`;
  const filePath = path.join(logoDirectory, name);
  const base = sharp({
    create: {
      width: 160,
      height: 160,
      channels: 4,
      background: opaque ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  const buffer = opaque
    ? await base.png().toBuffer()
    : await base.composite([{
        input: await sharp({ create: { width: 80, height: 80, channels: 4, background: { r: 0, g: 120, b: 50, alpha: 1 } } }).png().toBuffer(),
        left: 40,
        top: 40,
      }]).png().toBuffer();
  await writeFile(filePath, buffer);
  createdFiles.push(filePath);
  return { name, url: `/uploads/logos/${name}` };
}

vi.mock('@/lib/server/wps-production-garments', () => ({ verifyGarmentBinding: vi.fn() }));
vi.mock('@/lib/server/catalog-files', () => ({ readCatalogFile: vi.fn() }));

describe('WPS production artwork assets', () => {
  it('previews unconfirmed front and back artwork without saving or making it deliverable', async () => {
    const logo = await saveTestLogo(false);
    const { readCatalogFile } = await import('@/lib/server/catalog-files');
    const { createHash } = await import('node:crypto');
    const garmentBytes = await sharp({ create: { width: 1000, height: 500, channels: 4, background: '#eeeeee' } }).png().toBuffer();
    const garment = garmentFixture();
    garment.sha256 = createHash('sha256').update(garmentBytes).digest('hex');
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: garmentBytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    const review = taskReviewFixture()[2];
    review.units.forEach(unit => { unit.garment = garment; });
    let state = importTaskReviews(emptyWpsProductionState(), [review]);
    const validation = await validateProductionArtwork(logo.url);
    // Preview must also work before quality and human confirmation, including multiple faces.
    for (const unit of state.units) state = attachProductionArtwork(state, unit.id, { ...logo, validation, service: 'manual-upload', requestSummary: 'isolated preview test' }, randomUUID());
    const before = JSON.stringify(state), version = state.mockupVersions[0];
    const png = await renderProductionPreview(version, state.units);
    for (const left of [286, 798]) {
      const pixel = await sharp(png).extract({ left: left * CONFIRMATION_OUTPUT.scale, top: 382 * CONFIRMATION_OUTPUT.scale, width: 1, height: 1 }).raw().toBuffer();
      expect([...pixel.subarray(0, 3)]).toEqual([0, 120, 50]);
    }
    expect(JSON.stringify(state)).toBe(before);
    expect(state.units.every(unit => !unit.gateA && !unit.gateB)).toBe(true);
    await expect(composeProductionMockup({ ...version, composeFingerprint: 'test-only' }, state.units)).rejects.toThrow('尚未确认');
    const missing = state.units.map(unit => ({ ...unit, placement: null }));
    const blank = await renderProductionPreview(version, missing);
    const pixel = await sharp(blank).extract({ left: 286 * CONFIRMATION_OUTPUT.scale, top: 382 * CONFIRMATION_OUTPUT.scale, width: 1, height: 1 }).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([238, 238, 238]);
    await expect(renderProductionPreview(version, state.units.map(unit => ({ ...unit, artwork: { ...unit.artwork!, validation: { ...validation, sha256: '0'.repeat(64) } } })))).rejects.toThrow('素材文件已变化');
  });

  it('exports the same trimmed logo size and face-relative location shown by the task editor', async () => {
    const logo = await saveTestLogo(false);
    const { readCatalogFile } = await import('@/lib/server/catalog-files');
    const garmentBytes = await sharp({ create: { width: 1000, height: 500, channels: 4, background: '#eeeeee' } }).png().toBuffer();
    const { createHash } = await import('node:crypto');
    const garment = garmentFixture();
    garment.sha256 = createHash('sha256').update(garmentBytes).digest('hex');
    garment.views.forEach(view => { view.standard = null; });
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: garmentBytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    const review = taskReviewFixture()[2];
    review.units.forEach(unit => { unit.garment = garment; });
    let state = importTaskReviews(emptyWpsProductionState(), [review]);
    const validation = await validateProductionArtwork(logo.url);
    validation.quality = artworkQualityFixture(validation.sha256);
    for (const unit of state.units) {
      state = attachProductionArtwork(state, unit.id, { ...logo, validation, service: 'auto', requestSummary: '本地测试' }, randomUUID());
      state = confirmProductionArtwork(state, unit.id, '测试员');
      const placement = { ...unit.placement!, manual: { centerX: .6, centerY: .4, width: .2 } };
      state = placeProductionArtwork(state, unit.id, placement, validation, '测试员');
    }
    state = markVersionComposing(state, state.mockupVersions[0].id);
    const output = await composeProductionMockup(state.mockupVersions[0], state.units);
    const outputPath = path.join(mockupDirectory, output.name);
    createdFiles.push(outputPath);
    // Each opaque 500 × 500 face occupies a 476 × 476 slot in the supplied frame.
    const frameScale = 476 * CONFIRMATION_OUTPUT.scale / 500;
    const frameTop = 144 * CONFIRMATION_OUTPUT.scale;
    for (const unit of state.units) {
      const geometry = placementPreview(garment, unit.placement!, validation);
      const expectedWidth = unit.placement!.key === 'back' ? 130 : 120;
      expect(geometry.width).toBeCloseTo(expectedWidth);
      expect(geometry.height).toBeCloseTo(expectedWidth);
      const back = unit.placement!.key === 'back';
      const centerX = (back ? 560 : 48) * CONFIRMATION_OUTPUT.scale + (geometry.centerX - (back ? 500 : 0)) * frameScale;
      const centerY = Math.round(frameTop + geometry.centerY * frameScale);
      const painted = await sharp(outputPath).extract({ left: Math.round(centerX - geometry.width * frameScale / 2 + 3 * CONFIRMATION_OUTPUT.scale), top: centerY, width: 1, height: 1 }).raw().toBuffer();
      const outside = await sharp(outputPath).extract({ left: Math.round(centerX - geometry.width * frameScale / 2 - 6 * CONFIRMATION_OUTPUT.scale), top: centerY, width: 1, height: 1 }).raw().toBuffer();
      expect([...painted.subarray(0, 3)]).toEqual([0, 120, 50]);
      expect([...outside.subarray(0, 3)]).toEqual([238, 238, 238]);
    }
  });
  it('checks real alpha pixels rather than trusting the .png extension', async () => {
    const transparent = await saveTestLogo(false);
    const opaque = await saveTestLogo(true);
    const valid = await validateProductionArtwork(transparent.url);
    const invalid = await validateProductionArtwork(opaque.url);
    expect(valid.valid).toBe(true);
    expect(valid.transparentPixelRatio).toBeGreaterThan(0.5);
    expect(valid.contentBounds).toEqual({ left: 40, top: 40, width: 80, height: 80 });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues).toContain('透明像素不足 1%，疑似带有实体背景');
  });

  it('composes front and back logos on one selected garment, retaining margins and saved pixels/hash', async () => {
    const logo = await saveTestLogo(false);
    const { readCatalogFile } = await import('@/lib/server/catalog-files');
    const garmentBytes = await sharp({ create: { width: 1000, height: 500, channels: 4, background: '#eeeeee' } }).png().toBuffer();
    const { createHash } = await import('node:crypto');
    const garment = garmentFixture();
    garment.sha256 = createHash('sha256').update(garmentBytes).digest('hex');
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: garmentBytes } as Awaited<ReturnType<typeof readCatalogFile>>);
    const review = taskReviewFixture()[2];
    review.units.forEach(unit => { unit.garment = garment; });
    let state = importTaskReviews(emptyWpsProductionState(), [review]);
    for (const unit of state.units) {
    const unitId = unit.id;
    state = confirmProductionPlan(state, unitId, '测试员');
    const validation = await validateProductionArtwork(logo.url);
    validation.quality = artworkQualityFixture(validation.sha256);
    state = attachProductionArtwork(state, unitId, {
      url: logo.url,
      name: logo.name,
      validation,
      service: 'auto',
      requestSummary: '本地透明 PNG 测试',
    }, randomUUID());
    state = confirmProductionArtwork(state, unitId, '测试员');
    }
    expect(state.mockupVersions).toHaveLength(1);
    const versionId = state.mockupVersions[0].id;
    state = markVersionComposing(state, versionId);
    const version = state.mockupVersions[0];
    const output = await composeProductionMockup(version, state.units);
    const outputPath = path.join(mockupDirectory, output.name);
    createdFiles.push(outputPath);
    expect(output.url).toBe(`/uploads/mockups/${output.name}`);
    expect(output.width).toBe(CONFIRMATION_OUTPUT.width);
    expect(output.height).toBe(CONFIRMATION_OUTPUT.height);
    expect(output.byteLength).toBeGreaterThan(100);
    const pixel = await sharp(outputPath).extract({ left: 286 * CONFIRMATION_OUTPUT.scale, top: 382 * CONFIRMATION_OUTPUT.scale, width: 1, height: 1 }).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([0, 120, 50]);
    const backPixel = await sharp(outputPath).extract({ left: 798 * CONFIRMATION_OUTPUT.scale, top: 382 * CONFIRMATION_OUTPUT.scale, width: 1, height: 1 }).raw().toBuffer();
    expect([...backPixel.subarray(0, 3)]).toEqual([0, 120, 50]);
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const preview = await renderProductionMockup(version, state.units);
    expect(preview.equals(await readFile(outputPath))).toBe(true);
    const frame = await sharp(await readFile(path.join('public', CONFIRMATION_FRAME.assetPath))).resize(CONFIRMATION_OUTPUT.width, CONFIRMATION_OUTPUT.height).png().toBuffer();
    for (const region of [{ left: 0, top: 0, width: 3252, height: 282 }, { left: 0, top: 1860, width: 3252, height: 441 }]) {
      const original = await sharp(frame).extract(region).removeAlpha().raw().toBuffer();
      const delivered = await sharp(outputPath).extract(region).removeAlpha().raw().toBuffer();
      expect(delivered.equals(original)).toBe(true);
    }
    await expect(composeProductionMockup(version, state.units.slice(0, 1))).rejects.toThrow('定制单元不完整');
    await expect(composeProductionMockup(version, state.units.map(unit => ({ ...unit, gateB: null })))).rejects.toThrow('尚未确认');
    const changedArtwork = state.units.map(unit => ({ ...unit, artwork: { ...unit.artwork!, validation: { ...unit.artwork!.validation, sha256: '0'.repeat(64) } } }));
    await expect(renderProductionMockup(version, changedArtwork)).rejects.toThrow('素材文件已变化');
  });
});
