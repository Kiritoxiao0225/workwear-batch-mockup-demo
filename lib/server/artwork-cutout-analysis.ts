import sharp from 'sharp';
import type { ArtworkCutoutDecision, ArtworkCutoutMode } from '@/lib/artwork-cutout';
import { ARTWORK_CUTOUT_VERSION } from '@/lib/artwork-cutout';
import { inspectArtworkSource, alphaMaskReport, assertUsableArtworkMask, missingArtworkForegroundRegions } from './artwork-image-processing';
import { detectArtworkBadges } from './artwork-badge-protection';

/** Simple holes need segmentation; fine foreground details need the precision route.
 * Explicit standard mode keeps Volcano available even for detailed artwork. */
export async function analyzeArtworkCutout(bytes: Buffer, mode: ArtworkCutoutMode = 'auto'): Promise<ArtworkCutoutDecision> {
  const profile = await inspectArtworkSource(bytes);
  const decision = (route: ArtworkCutoutDecision['route'], reasons: string[]): ArtworkCutoutDecision => ({ route, reasons, estimatedCredits: route === 'volcano' ? null : route === 'meitu' ? 1 : 0, version: ARTWORK_CUTOUT_VERSION });
  if (profile.kind === 'transparent') {
    assertUsableArtworkMask(await alphaMaskReport(bytes));
    return decision('reuse', ['已有可用透明背景，保留原图']);
  }
  const badgeReasons = (await detectArtworkBadges(bytes)).length ? ['检测到完整圆形徽章：保护圆内原图底色与图形'] : [];
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

export async function validateCutoutOutput(bytes: Buffer, source?: Buffer) {
  const meta = await sharp(bytes).metadata();
  if (meta.format !== 'png' || !meta.hasAlpha) throw new Error('结果必须为带透明通道的 PNG');
  assertUsableArtworkMask(await alphaMaskReport(bytes));
  if (source) {
    const profile = await inspectArtworkSource(source);
    if (meta.width !== profile.width || meta.height !== profile.height) throw new Error('抠图前后画布尺寸不一致，请核对完整图案与排版');
    if (profile.backgroundColor && profile.dominantBorderRatio >= .95 && profile.borderEdgeDensity <= .02
      && (await missingArtworkForegroundRegions(source, bytes, profile.backgroundColor, { minimumAlpha: 64 })).length) {
      throw new Error('抠图结果丢失了原图中的文字或独立图形，请核对原图');
    }
  }
}
