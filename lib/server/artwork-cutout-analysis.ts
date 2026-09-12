import sharp from 'sharp';
import { ARTWORK_INTEGRITY_VERSION, inspectArtworkCompleteness } from './artwork-foreground-integrity';
import { assertArtworkMask, panelIntegritySource } from './artwork-panel-mask';
import type { ArtworkProtectionPolicy } from '@/lib/artwork-protection';
import type { ArtworkCutoutDecision, ArtworkCutoutMode } from '@/lib/artwork-cutout';
import { ARTWORK_CUTOUT_VERSION } from '@/lib/artwork-cutout';
import { inspectArtworkSource } from './artwork-image-processing';
import { detectArtworkBadges } from './artwork-badge-protection';
import type { ArtworkCutoutRegion, ArtworkCutoutIntegrity } from '@/lib/artwork-cutout';
import type { ArtworkWatermarkEvidence } from './artwork-content-inspection';

/** Simple holes need segmentation; fine foreground details need the precision route.
 * Explicit standard mode keeps Volcano available even for detailed artwork. */
export async function analyzeArtworkCutout(bytes: Buffer, mode: ArtworkCutoutMode = 'auto', protection?: ArtworkProtectionPolicy): Promise<ArtworkCutoutDecision> {
  const profile = await inspectArtworkSource(bytes);
  const decision = (route: ArtworkCutoutDecision['route'], reasons: string[]): ArtworkCutoutDecision => ({ route, reasons, estimatedCredits: route === 'volcano' ? null : route === 'meitu' ? 1 : 0, version: ARTWORK_CUTOUT_VERSION });
  if (profile.kind === 'transparent') {
    await assertArtworkMask(bytes, protection);
    return decision('reuse', ['已有可用透明背景，保留原图']);
  }
  const badgeReasons = protection?.background?.scope !== 'all-background' && (await detectArtworkBadges(bytes)).length ? ['检测到完整圆形徽章：保护圆内原图底色与图形'] : [];
  if (mode === 'meitu') return decision('meitu', ['手动选择美图精细', ...badgeReasons]);
  const risks: string[] = [];
  const fineDetails: string[] = [];
  if (profile.dominantBorderRatio < .95 || profile.borderEdgeDensity > .02 || !profile.backgroundColor) risks.push('背景不够均匀');
  if (!risks.length && profile.backgroundColor) {
    const { data, info } = await sharp(bytes).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, n = w * h, foreground = new Uint8Array(n), visited = new Uint8Array(n);
    const bg = profile.backgroundColor;
    let count = 0, boundary = 0, lowContrast = 0;
    for (let p = 0; p < n; p++) {
      const i = p * 4, distance = Math.hypot(data[i] - bg.r, data[i + 1] - bg.g, data[i + 2] - bg.b);
      if (data[i + 3] > 128 && distance > 48) { foreground[p] = 1; count++; if (distance < 100) lowContrast++; }
    }
    let components = 0, small = 0, enclosed = 0;
    const queue = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (visited[start]) continue;
      const kind = foreground[start]; let head = 0, tail = 1, touchesBorder = false;
      queue[0] = start; visited[start] = 1;
      while (head < tail) {
        const p = queue[head++], x = p % w, y = Math.floor(p / w);
        if (!x || !y || x === w - 1 || y === h - 1) touchesBorder = true;
        const neighbors = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        if (kind && neighbors.some(q => q < 0 || !foreground[q])) boundary++;
        for (const q of neighbors) if (q >= 0 && !visited[q] && foreground[q] === kind) { visited[q] = 1; queue[tail++] = q; }
      }
      if (kind && tail >= 3) { components++; if (tail < 100) small++; }
      if (!kind && !touchesBorder && tail >= 3) enclosed += tail;
    }
    if (count < n * .005 || count > n * .8) risks.push('主体范围需要精细识别');
    if (enclosed > 3) risks.push('包含镂空或封闭底色');
    if (components >= 6 || small >= 3) fineDetails.push('包含小字或分散细节');
    if (count && boundary / count > .24) fineDetails.push('细笔画较多');
    if (count && lowContrast / count > .1) fineDetails.push('主体与背景颜色接近');
  }
  if (mode === 'auto' && fineDetails.length) return decision('meitu', [...risks, ...fineDetails, ...badgeReasons, '自动精细分流：优先保留小字、细线和低反差细节']);
  return risks.length || fineDetails.length
    ? decision('volcano', [...risks, ...fineDetails, ...badgeReasons, mode === 'standard' ? '手动标准：使用火山模型并检查结果' : '使用火山处理背景或普通镂空，完成后检查实际结果'])
    : decision('standard', ['底色均匀', '实心粗线条', '主体反差明确', ...badgeReasons]);
}

export class ArtworkCutoutContentError extends Error {
  constructor(public missingRegions: ArtworkCutoutRegion[]) { super('抠图结果疑似丢失文字或独立图形，请对照标记区域核对'); }
}

export class ArtworkCutoutGeometryError extends Error {
  constructor(public changedRegions: ArtworkCutoutRegion[]) { super('抠图结果新增了原透明区的可见像素，可能填充负形或增加轮廓；候选已保留，请核对'); }
}

export async function validateCutoutOutput(bytes: Buffer, source?: Buffer, options: {
  inspectWatermarks?: (source: Buffer, missing: ArtworkCutoutRegion[]) => Promise<ArtworkWatermarkEvidence[]>;
  protection?: ArtworkProtectionPolicy;
} = {}): Promise<{ watermarks: ArtworkWatermarkEvidence[]; integrity: ArtworkCutoutIntegrity }> {
  const meta = await sharp(bytes).metadata();
  if (meta.format !== 'png' || !meta.hasAlpha) throw new Error('结果必须为带透明通道的 PNG');
  await assertArtworkMask(bytes, options.protection);
  if (source) {
    const completeness = await inspectArtworkCompleteness(await panelIntegritySource(source, options.protection), bytes);
    if (completeness.status === 'uncertain') return { watermarks: [], integrity: { version: ARTWORK_INTEGRITY_VERSION,
      status: 'uncertain', basis: completeness.basis, warning: '当前背景无法可靠建立前景完整性证据；未认证内容完整，请对照原图与供应商候选人工核对，不自动重绘。' } };
    if (completeness.addedRegions.length) throw new ArtworkCutoutGeometryError(completeness.addedRegions);
    const missing = completeness.missingRegions;
    if (missing.length) {
      // A missing customer component is never excused by a failed/uncertain model call.
      const watermarks = await options.inspectWatermarks?.(source, missing).catch(() => []) ?? [];
      const unexplained = missing.filter(region => !watermarks.some(({ bounds }) => bounds.width * bounds.height <= meta.width! * meta.height! * .08
        && bounds.left >= 0 && bounds.top >= 0 && bounds.width > 0 && bounds.height > 0
        && bounds.left + bounds.width <= meta.width! && bounds.top + bounds.height <= meta.height!
        && bounds.left <= region.left && bounds.top <= region.top
        && bounds.left + bounds.width >= region.left + region.width && bounds.top + bounds.height >= region.top + region.height));
      if (unexplained.length) throw new ArtworkCutoutContentError(unexplained);
      return { watermarks, integrity: { version: ARTWORK_INTEGRITY_VERSION, status: 'checked', basis: completeness.basis } };
    }
    return { watermarks: [], integrity: { version: ARTWORK_INTEGRITY_VERSION, status: 'checked', basis: completeness.basis } };
  }
  return { watermarks: [], integrity: { version: ARTWORK_INTEGRITY_VERSION, status: 'mask-only', basis: 'no-source' } };
}
