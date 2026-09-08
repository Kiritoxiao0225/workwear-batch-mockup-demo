'use client';
import { useEffect, useState } from 'react';
import type { ArtworkDraft } from '@/lib/artwork-editor';
import { renderArtworkPreview } from '@/lib/client/render-artwork';
import type { ProductionUnit } from '@/lib/wps-production';
import { initialTaskPlacement, placementPreview } from '@/lib/production-preview';
import { printSizeCm } from '@/lib/production-sizing';
import { printedTextHeights } from '@/lib/production-legibility';
import { garmentBindingSchema, productionGarmentPreviewCrop } from '@/lib/production-garment';
import { useProjectSession } from '@/components/project-session';

type Preview = Awaited<ReturnType<typeof renderArtworkPreview>> & { url: string; draft: ArtworkDraft };
export function WpsArtworkSizePreview({ unit, draft }: { unit: ProductionUnit; draft: ArtworkDraft }) {
  const session = useProjectSession();
  const [garment, setGarment] = useState(unit.garment);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [garmentError, setGarmentError] = useState<string | null>(null);
  useEffect(() => {
    if (!session.user || !unit.garment || unit.garment.views.every(view => view.bodyScale)) return;
    const abort = new AbortController();
    void (async () => {
      const response = await fetch(`/api/wps-production/artwork-inspection?unitId=${encodeURIComponent(unit.id)}&sizing=true`, { cache: 'no-store', signal: abort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '衣服尺寸读取失败');
      const checked = garmentBindingSchema.parse(result.garment);
      if (checked.assetVersionId !== unit.garment?.assetVersionId) throw new Error('衣服底图已变化，请重新打开编辑器');
      setGarment(checked);
    })().catch(error => { if (!abort.signal.aborted) setGarmentError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, [unit.id, unit.garment, session.user]);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    const timer = window.setTimeout(() => {
      void renderArtworkPreview(draft).then(result => {
        if (!active) return;
        url = URL.createObjectURL(result.blob);
        setPreview({ ...result, url, draft });
        setError(null);
      }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [draft]);
  if (!unit.placement || !unit.artwork || !unit.garment) return null;
  let layout: { size: ReturnType<typeof printSizeCm>; heights: ReturnType<typeof printedTextHeights>; face: NonNullable<ReturnType<typeof productionGarmentPreviewCrop>>; geometry: ReturnType<typeof placementPreview> | undefined; rotation: number } | null = null;
  let message = error ?? garmentError;
  if (preview && preview.draft === draft && garment) {
    try {
      const validation = { ...unit.artwork.validation, width: preview.width, height: preview.height, contentBounds: preview.contentBounds };
      const placement = initialTaskPlacement({ ...unit, garment }, validation);
      const size = printSizeCm(placement, preview.contentBounds.width / preview.contentBounds.height);
      const heights = printedTextHeights(preview.letters, preview.contentBounds.height, size.height);
      const face = productionGarmentPreviewCrop(garment, placement)!;
      let geometry;
      try { geometry = placementPreview(garment, placement, validation); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      layout = { size, heights, face, geometry, rotation: placement.rotation };
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
  }
  return <section className="artwork-garment-preview" aria-label="上衣字高检查"><details open><summary>上衣效果与字高检查</summary>
    {layout && preview && garment ? <><p>整组预计 {layout.size.width.toFixed(2)} × {layout.size.height.toFixed(2)} cm · 衣身宽 55 cm</p>
        {layout.geometry && session.user && <svg viewBox={`${layout.face.x} ${layout.face.y} ${layout.face.width} ${layout.face.height}`} role="img" aria-label="当前排版上衣效果预览"><image href={garment.imageUrl} width={garment.width} height={garment.height}/><g transform={`translate(${layout.geometry.centerX} ${layout.geometry.centerY}) rotate(${layout.rotation})`}><svg x={-layout.geometry.width/2} y={-layout.geometry.height/2} width={layout.geometry.width} height={layout.geometry.height} viewBox={`${preview.contentBounds.left} ${preview.contentBounds.top} ${preview.contentBounds.width} ${preview.contentBounds.height}`}><image href={preview.url} width={preview.width} height={preview.height}/></svg></g></svg>}
        {layout.heights.map(group => <p className={group.small ? 'artwork-text-warning' : ''} key={group.name}>{group.name}最小字高约 <b>{group.heightCm.toFixed(2)} cm</b>{group.small ? `，偏小：建议至少 ${group.minimum} cm，优先 ${group.recommended} cm。` : '，已达到项目提醒线。'}</p>)}
        {!layout.heights.length && <p>当前图案没有可单独测量的文字层，请放大核对图片中的小字。</p>}
        {draft.extraGraphics?.some(graphic => graphic.role === 'styledText') && <p>图片形式的特殊文字未计入字高检测，请单独核对。</p>}
        <small>字高按实际可见字形估算。提高字号或缩小上方图形后重新查看；刺绣、细笔画和低对比配色仍需打样核对。</small></> : <p>正在更新上衣预览…</p>}
    {!session.user && <p>登录工作台后显示服装底图；图案编辑与字高检查可继续。</p>}
    {message && <p className="artwork-text-warning">{message}</p>}
    </details></section>;
}
