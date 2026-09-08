'use client';
import { useEffect, useState } from 'react';
import { artworkTextLayers } from '@/lib/artwork-editor';
import { artworkTextLayout, loadArtworkFont } from '@/lib/client/artwork-text-layout';
import { ARTWORK_EXPORT_SCALE } from '@/lib/client/render-artwork';
import { printedTextHeights } from '@/lib/production-legibility';
import { artworkContentBounds } from '@/lib/production-preview';
import { printSizeCm } from '@/lib/production-sizing';
import type { ProductionPlacement, ProductionUnit } from '@/lib/wps-production';

export function WpsTextSizeNotice({ unit, placement, edit }: { unit: ProductionUnit; placement: ProductionPlacement; edit: () => void }) {
  const [measured, setMeasured] = useState<{ draft: typeof unit.artwork; letters: { char: string; height: number }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const artwork = unit.artwork;
    if (!artwork?.draft) return;
    const texts = artworkTextLayers(artwork.draft).filter(text => text.visible !== false);
    void Promise.all(texts.map(loadArtworkFont)).then(() => {
      const letters = texts.flatMap(text => artworkTextLayout(text).letters.map(letter => ({ ...letter, height: letter.height * ARTWORK_EXPORT_SCALE })));
      if (active) { setMeasured({ draft: artwork, letters }); setError(null); }
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [unit.artwork]);
  const bounds = unit.artwork ? artworkContentBounds(unit.artwork.validation) : null;
  const heights = bounds && measured?.draft === unit.artwork ? printedTextHeights(measured.letters, bounds.height, printSizeCm(placement, bounds.width / bounds.height).height) : [];
  return <section className="artwork-garment-preview" aria-label="贴图文字尺寸提醒"><strong>贴图后的小字</strong>
    {heights.map(group => <p key={group.name} className={group.small ? 'artwork-text-warning' : ''}>{group.name}约 <b>{group.heightCm.toFixed(2)} cm</b>{group.small ? `，偏小，建议至少 ${group.minimum} cm。` : '，达到项目提醒线。'}</p>)}
    {!heights.length && <p>{error ?? (unit.artwork?.draft && !measured ? '正在测量文字…' : '没有可单独测量的文字层，请放大核对小字。')}</p>}
    <small>按当前文字草稿与 PNG 可见高度估算；图片内文字未检测。文字与衣服的颜色对比也需核对，尺寸提醒不代表生产验收。</small>
    <button type="button" onClick={edit}>调整小字排版</button>
  </section>;
}
