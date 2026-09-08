import { readProductionFile, usesProductionCloud } from './production-storage';
import { savedProductionRender } from './production-render-cache';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp, { type OverlayOptions } from 'sharp';

import { productionPlacementGeometry } from '@/lib/production-garment';
import { verifyGarmentBinding } from '@/lib/server/wps-production-garments';
import { readCatalogFile } from '@/lib/server/catalog-files';
import { initialTaskPlacement } from '@/lib/production-preview';
import { withGarmentBodyScale } from '@/lib/server/wps-garment-sizing';
import { renderConfirmationFrame } from '@/lib/server/confirmation-frame';
import { CONFIRMATION_FRAME, CONFIRMATION_OUTPUT } from '@/lib/confirmation-frame';
import type {
  ArtworkValidation,
  MockupOutput,
  ProductionMockupVersion,
  ProductionUnit,
} from '@/lib/wps-production';
import { WPS_COMPOSITOR_VERSION } from '@/lib/wps-production';

const PUBLIC_ROOT = path.join(process.cwd(), 'public');
const ARTWORK_ROOT = path.join(PUBLIC_ROOT, 'uploads', 'logos');
const MOCKUP_ROOT = path.join(PUBLIC_ROOT, 'uploads', 'mockups');
const MAX_ARTWORK_BYTES = 12 * 1024 * 1024;

function sha256(buffer: Buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function publicAssetPath(url: string, allowedRoot: 'logos' | 'mockups') {
  const prefix = `/uploads/${allowedRoot}/`;
  if (typeof url !== 'string' || !url.startsWith(prefix)) {
    throw new Error(`文件 URL 只允许 ${prefix} 下的本地文件，实际值：${String(url)}`);
  }
  const relative = url.slice(prefix.length);
  if (!relative || relative.includes('/') || relative.includes('\\') || relative === '.' || relative === '..') {
    throw new Error(`文件 URL 包含无效文件名：${url}`);
  }
  const root = allowedRoot === 'logos' ? ARTWORK_ROOT : MOCKUP_ROOT;
  const resolved = path.resolve(root, relative);
  if (path.dirname(resolved) !== root) throw new Error(`文件 URL 越过允许目录：${url}`);
  return resolved;
}

export async function validateProductionArtwork(url: string, now = new Date()): Promise<ArtworkValidation> {
  const buffer = await readProductionFile(url);
  if (!buffer.length || buffer.length > MAX_ARTWORK_BYTES) throw new Error('素材图大小超出允许范围');
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  if (metadata.format !== 'png') throw new Error(`素材图必须是 PNG，实际格式：${metadata.format ?? 'unknown'}`);
  if (!metadata.width || !metadata.height) throw new Error(`无法读取素材图尺寸：${url}`);

  const sample = await sharp(buffer, { failOn: 'error' })
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let index = 3; index < sample.data.length; index += 4) {
    const alpha = sample.data[index];
    if (alpha < 250) transparentPixels += 1;
    if (alpha > 5) visiblePixels += 1;
  }
  const pixelCount = sample.info.width * sample.info.height;
  const transparentPixelRatio = pixelCount ? transparentPixels / pixelCount : 0;
  const visiblePixelRatio = pixelCount ? visiblePixels / pixelCount : 0;
  const issues: string[] = [];
  if (!metadata.hasAlpha) issues.push('PNG 没有 Alpha 通道');
  if (transparentPixelRatio < 0.01) issues.push('透明像素不足 1%，疑似带有实体背景');
  if (visiblePixelRatio < 0.002) issues.push('有效图案像素不足 0.2%，素材可能为空');
  if (metadata.width < 64 || metadata.height < 64) issues.push('素材尺寸小于 64px，清晰度不足');

  const trimmed = visiblePixels ? await sharp(buffer).trim({ background: '#00000000', threshold: 0 }).png().toBuffer({ resolveWithObject: true }) : null;
  return {
    ...(trimmed ? { contentBounds: { left: -(trimmed.info.trimOffsetLeft ?? 0), top: -(trimmed.info.trimOffsetTop ?? 0), width: trimmed.info.width, height: trimmed.info.height } } : {}),
    valid: issues.length === 0,
    mimeType: 'image/png',
    width: metadata.width,
    height: metadata.height,
    byteLength: buffer.byteLength,
    sha256: sha256(buffer),
    transparentPixelRatio,
    visiblePixelRatio,
    checkedAt: now.toISOString(),
    ruleVersion: 'transparent-artwork-v1',
    issues,
  };
}

// Preview and delivery use the same pixels. Only final delivery checks both confirmations.
// Draft rendering uses the same initial position as the editor and never saves or confirms it.
export async function productionPreviewUnits(units: ProductionUnit[]) {
  const candidates = await Promise.all(units.filter(unit => unit.artwork && unit.placement).map(async unit => {
    if (unit.gateA) return unit;
    if (!unit.garment) throw new Error(`定制单元 ${unit.id} 尚未选择衣服`);
    const garment = await withGarmentBodyScale(unit.garment);
    return { ...unit, garment, placement: initialTaskPlacement({ ...unit, garment }, unit.artwork!.validation) };
  }));
  return candidates;
}
export async function renderProductionPreview(version: ProductionMockupVersion, units: ProductionUnit[]) {
  if (usesProductionCloud()) return (await savedProductionRender(version, units)).bytes;
  return renderProductionMockup(version, await productionPreviewUnits(units));
}

export async function renderProductionMockup(
  version: ProductionMockupVersion,
  units: ProductionUnit[],
) {
  const garment = version.garment;
  if (!garment) throw new Error('历史测试版本尚未选择真实款式和颜色');
  const bindings = new Map<string, Promise<unknown>>();
  const verify = (binding: NonNullable<ProductionUnit['garment']>) => {
    const key = JSON.stringify(binding);
    if (!bindings.has(key)) bindings.set(key, verifyGarmentBinding(binding));
    return bindings.get(key)!;
  };
  const [, { bytes: garmentBytes }] = await Promise.all([
    verify(garment), readCatalogFile(garment.imageUrl.split('/').at(-1)!, { accelerated: true }),
  ]);
  if (sha256(garmentBytes) !== garment.sha256) throw new Error('服装底图内容与确认版本不一致');
  const garmentMetadata = await sharp(garmentBytes, { failOn: 'error' }).metadata();
  if (garmentMetadata.width !== garment.width || garmentMetadata.height !== garment.height) throw new Error('服装底图尺寸与确认版本不一致');

  const renderOverlay = async (unit: ProductionUnit): Promise<OverlayOptions> => {
    if (!version.unitIds.includes(unit.id)) throw new Error(`定制单元 ${unit.id} 不属于版本 ${version.id}`);
    if (!unit.artwork || !unit.placement) {
      throw new Error(`定制单元 ${unit.id} 缺少图案或位置`);
    }
    if (unit.garment?.variantId !== garment.variantId || unit.garment?.assetVersionId !== garment.assetVersionId) throw new Error(`定制单元 ${unit.id} 与效果图版本的衣服不一致`);
    const [, source] = await Promise.all([verify(unit.garment), readProductionFile(unit.artwork.url)]);
    if (sha256(source) !== unit.artwork.validation.sha256) {
      throw new Error(`定制单元 ${unit.id} 的素材文件已变化，请重新确认门 B`);
    }
    // Remove transparent margins so the visible artwork, rather than its blank canvas, meets the anchor.
    const trimmed = await sharp(source, { failOn: 'error' }).trim({ background: '#00000000', threshold: 0 }).png().toBuffer({ resolveWithObject: true });
    const geometry = productionPlacementGeometry(unit.garment, unit.placement, trimmed.info.width / trimmed.info.height);
    const targetWidth = Math.max(1, Math.floor(geometry.width));
    let transformed = sharp(trimmed.data, { failOn: 'error' }).resize({ width: targetWidth });
    if (unit.placement.rotation !== 0) {
      transformed = transformed.rotate(unit.placement.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
    const rendered = await transformed.png().toBuffer({ resolveWithObject: true });
    return {
      input: rendered.data,
      left: Math.round(geometry.centerX - rendered.info.width / 2),
      top: Math.round(geometry.centerY - rendered.info.height / 2),
    };
  };
  // Keep deterministic layer order and bound decoded-image memory for large jobs.
  const ordered = [...units].sort((left, right) => left.id.localeCompare(right.id));
  const overlays: OverlayOptions[] = [];
  for (let offset = 0; offset < ordered.length; offset += 3) {
    overlays.push(...await Promise.all(ordered.slice(offset, offset + 3).map(renderOverlay)));
  }

  // Apply every Logo in original garment coordinates, then move/scale each complete face together.
  const printedGarment = await sharp(garmentBytes, { failOn: 'error' }).composite(overlays).png().toBuffer();
  const frame = await readFile(path.join(PUBLIC_ROOT, CONFIRMATION_FRAME.assetPath));
  return renderConfirmationFrame(printedGarment, frame, garment.views.map(({ face, crop }) => ({ face, crop })));
}

export async function composeProductionMockup(
  version: ProductionMockupVersion,
  units: ProductionUnit[],
  now = new Date(),
): Promise<MockupOutput> {
  if (!version.composeFingerprint) throw new Error(`版本 ${version.id} 缺少 composeFingerprint`);
  if (units.length !== version.unitIds.length || new Set(units.map(unit => unit.id)).size !== units.length
    || units.some(unit => !version.unitIds.includes(unit.id))) throw new Error(`版本 ${version.id} 的定制单元不完整或重复`);
  for (const unit of units) {
    if (!unit.artwork || !unit.gateB || !unit.gateA || !unit.placement) throw new Error(`定制单元 ${unit.id} 尚未确认图案或位置`);
  }
  if (usesProductionCloud()) {
    const { file } = await savedProductionRender(version, units);
    return { url: `/api/production-files/${file.id}`, name: `${version.id}-${String(file.sha256).slice(0,12)}.png`, sha256: file.sha256,
      width: file.width, height: file.height, byteLength: Number(file.byte_length), composeFingerprint: version.composeFingerprint,
      compositorVersion: WPS_COMPOSITOR_VERSION, createdAt: now.toISOString() };
  }
  const outputBuffer = await renderProductionMockup(version, units);
  const outputHash = sha256(outputBuffer);
  const safeVersionId = version.id.replace(/[^a-zA-Z0-9_-]/g, '-');
  const name = `${safeVersionId}-${outputHash.slice(0, 12)}.png`;
  await mkdir(MOCKUP_ROOT, { recursive: true });
  const temporaryPath = path.join(MOCKUP_ROOT, `.${name}.${randomUUID()}.tmp`);
  const outputPath = path.join(MOCKUP_ROOT, name);
  await writeFile(temporaryPath, outputBuffer);
  await rename(temporaryPath, outputPath);
  const saved = await readFile(outputPath);
  if (sha256(saved) !== outputHash) throw new Error(`合成图写入后校验失败：${name}`);

  return {
    url: `/uploads/mockups/${name}`,
    name,
    sha256: outputHash,
    width: CONFIRMATION_OUTPUT.width,
    height: CONFIRMATION_OUTPUT.height,
    byteLength: saved.byteLength,
    composeFingerprint: version.composeFingerprint,
    compositorVersion: WPS_COMPOSITOR_VERSION,
    createdAt: now.toISOString(),
  };
}
