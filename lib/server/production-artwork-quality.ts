import { readProductionFile } from './production-storage';
import sharp from 'sharp';
import { artworkGraphicLayers, type ArtworkDraft } from '@/lib/artwork-editor';
import { ARTWORK_ROUTING_STANDARD, artworkQualityPassed } from '@/lib/artwork-routing-standard';
import { validateProductionArtwork } from '@/lib/server/wps-production-assets';
import { artworkSha256, measureArtworkQuality } from '@/lib/server/artwork-quality';
import { readArtworkRoutingReport } from '@/lib/server/artwork-routing-records';
import type { ArtworkValidation } from '@/lib/wps-production';
import { productionFileId } from '@/lib/production-file-url';
import { catalogDatabase } from './catalog-database';

/** Saving editing progress checks file integrity only; third-party quality scores are optional. */
export async function validateProductionArtworkDraft(url: string, draft?: ArtworkDraft, previous?: ArtworkValidation, previousDraft?: ArtworkDraft) {
  const graphicsInRequest = draft ? artworkGraphicLayers(draft) : [];
  const requestedUrls = [...new Set([url, ...graphicsInRequest.flatMap(graphic => [graphic.sourceUrl, ...(graphic.recolorMaskUrl ? [graphic.recolorMaskUrl] : [])])])];
  const ids = requestedUrls.map(productionFileId).filter((id): id is string => Boolean(id));
  // These immutable objects were fully decoded and hash-verified at upload.
  // Read metadata together instead of downloading every unchanged layer on each save.
  const stored = ids.length ? (await catalogDatabase().query("SELECT id,sha256,mime_type,byte_length FROM files WHERE id=ANY($1::uuid[]) AND status='ready' AND gc_state='active'", [ids])).rows : [];
  if (stored.length !== ids.length) throw new Error('图层文件不存在或正在回收');
  const files = new Map(stored.map(file => [file.id, file]));
  const final = files.get(productionFileId(url));
  const validation = final && previous?.valid && previous.sha256 === final.sha256 ? structuredClone(previous) : await validateProductionArtwork(url);
  if (!validation.valid) throw new Error(`图案文件检查未通过：${validation.issues.join('；')}`);
  if (!draft) return { validation, draft: undefined };
  const verifiedDraft = structuredClone(draft);
  const claimedRunId = verifiedDraft.preprocessing?.routingReport?.runId;
  if (verifiedDraft.preprocessing) delete verifiedDraft.preprocessing.routingReport;
  const graphics = artworkGraphicLayers(verifiedDraft);
  const urls = [...new Set(graphics.flatMap(graphic => [graphic.sourceUrl, ...(graphic.recolorMaskUrl ? [graphic.recolorMaskUrl] : [])]))];
  const hashes = new Map(await Promise.all(urls.map(async sourceUrl => {
    const file = files.get(productionFileId(sourceUrl));
    if (file) {
      if (Number(file.byte_length) > 8 * 1024 * 1024 || Number(file.byte_length) < 1) throw new Error('图层文件大小必须在 1B 到 8MB 之间');
      if (file.mime_type !== 'image/png') throw new Error('图层必须保存为 PNG');
      return [sourceUrl, file.sha256 as string] as const;
    }
    const bytes = await readProductionFile(sourceUrl);
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('图层文件大小必须在 1B 到 8MB 之间');
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 32_000_000 });
    const metadata = await image.metadata();
    if (metadata.format !== 'png') throw new Error('图层必须保存为 PNG');
    await image.stats();
    return [sourceUrl, artworkSha256(bytes)] as const;
  })));
  // Keep only server-owned measurements of the same visible source pixels and score protocol.
  // The flattened PNG stays unmeasured, so a saved edit can never silently approve itself.
  validation.componentQuality = graphics.flatMap((graphic, index) => {
    if (graphic.visible === false) return [];
    const sha256 = hashes.get(graphic.sourceUrl);
    const known = previous?.componentQuality?.find(component => component.measurement.sha256 === sha256
      && component.measurement.protocol === ARTWORK_ROUTING_STANDARD.scoreProtocol);
    return known ? [{ id: graphic.id ?? `graphic-${index + 1}`, measurement: structuredClone(known.measurement) }] : [];
  });
  const persistedReport = previousDraft?.preprocessing?.routingReport;
  const report = claimedRunId ? (persistedReport?.runId === claimedRunId ? persistedReport
    : await readArtworkRoutingReport(claimedRunId)) : null;
  if (report && report.graphic.sha256 === hashes.get(graphics[0]?.sourceUrl) && verifiedDraft.preprocessing) {
    verifiedDraft.preprocessing.routingReport = report;
    validation.contentIssues = report.reviewReasons.filter(reason => /(?:重绘未完成|特殊字形尚未生成|文字仅为.*占位|缺少|文件.*变化)/u.test(reason));
  }
  return { validation, draft: verifiedDraft };
}

/** Evaluate the saved pixels, and reload routing evidence from the server instead of trusting the browser. */
export async function validateProductionArtworkQuality(url: string, draft?: ArtworkDraft, measure = measureArtworkQuality, previous?: ArtworkValidation) {
  const validation: ArtworkValidation = await validateProductionArtwork(url);
  const verifiedDraft = draft ? structuredClone(draft) : undefined;
  const claimedRunId = verifiedDraft?.preprocessing?.routingReport?.runId;
  if (verifiedDraft?.preprocessing) delete verifiedDraft.preprocessing.routingReport;
  if (!validation.valid) return { validation, draft: verifiedDraft };
  try {
    const finalBytes = await readProductionFile(url);
    if (artworkSha256(finalBytes) !== validation.sha256) throw new Error('文件在检测期间发生变化，请重新检测');
    validation.quality = await measure(finalBytes);
    const measured = new Map([[validation.sha256, validation.quality]]);
    validation.qualityIssues = [];
    validation.componentQuality = [];
    const report = claimedRunId ? await readArtworkRoutingReport(claimedRunId) : null;
    for (const [index, graphic] of (verifiedDraft ? artworkGraphicLayers(verifiedDraft) : []).entries()) {
      if (graphic.visible === false) continue;
      const bytes = await readProductionFile(graphic.sourceUrl);
      const sha256 = artworkSha256(bytes);
      const matchingReport = index === 0 && report?.graphic.sha256 === sha256 ? report : null;
      const recorded = matchingReport?.graphic.protocol === ARTWORK_ROUTING_STANDARD.scoreProtocol ? matchingReport.graphic : null;
      const cached = previous?.componentQuality?.find(component => artworkQualityPassed(component.measurement, sha256))?.measurement;
      const quality = recorded ?? cached ?? measured.get(sha256) ?? await measure(bytes);
      measured.set(sha256, quality);
      validation.componentQuality.push({ id: graphic.id ?? `graphic-${index + 1}`, measurement: quality });
      if (!artworkQualityPassed(quality, sha256)) validation.qualityIssues.push(`图案组件 ${index + 1}：${quality.score < ARTWORK_ROUTING_STANDARD.clarityMinimum ? `模糊检查未通过（换算清晰度 ${quality.score.toFixed(2)}）` : `有效像素不足（目标放大 ${quality.requiredScale.toFixed(2)} 倍）`}`);
      if (matchingReport && verifiedDraft?.preprocessing) {
        verifiedDraft.preprocessing.routingReport = matchingReport;
        if (recorded) validation.qualityIssues.push(...matchingReport.reviewReasons);
        else validation.qualityIssues.push(...matchingReport.reviewReasons.filter(reason => !/^(?:主体清晰度|净边后主体清晰度|文字“.+”清晰度)/u.test(reason)));
      }
    }
  } catch (error) {
    // Keep the candidate available for inspection, but never turn an unavailable check into a pass.
    validation.qualityError = `画质检测未完成：${error instanceof Error ? error.message : String(error)}`;
  }
  return { validation, draft: verifiedDraft };
}
