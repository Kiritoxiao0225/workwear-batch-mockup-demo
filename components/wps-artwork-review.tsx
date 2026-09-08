'use client';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { cutoutReplacementDraft } from '@/lib/client/artwork-cutout-preview';
import { artworkPngFile } from '@/lib/client/render-artwork';
import { CutoutModes, CutoutRules, CutoutTaskStatus, type CutoutSession } from '@/components/wps-cutout-controls';
import { CUTOUT_ROUTE_LABELS, cutoutFeeLabel, type ArtworkCutoutMode } from '@/lib/artwork-cutout';
import { WpsArtworkRouting } from '@/components/wps-artwork-routing';
import { LogoTextVerification } from '@/components/logo-text-verification';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionUnit } from '@/lib/wps-production';
import type { BrowserLogoTextVerification } from '@/lib/client/browser-logo-ocr';
import { artworkAcceptanceIssues, artworkQualityAdvice } from '@/lib/artwork-acceptance';

type Props = { cutoutSession?: CutoutSession; onReCutout: (mode: ArtworkCutoutMode) => void; onQueryCutout: () => void; onApplyCutout: () => void; onDiscardCutout: () => void; unit: ProductionUnit; source: SourceTaskRecord; busy: boolean; error: string | null; close: () => void; edit: () => void; onCheckQuality: () => void; onSaveTextCheck: (result: BrowserLogoTextVerification) => Promise<void> };
export function WpsArtworkReview({ unit, source, busy, error, close, edit, onCheckQuality, onSaveTextCheck, cutoutSession, onReCutout, onQueryCutout, onApplyCutout, onDiscardCutout }: Props) {
  const [background, setBackground] = useState('checker');
  const [view, setView] = useState('compare');
  const [zoom, setZoom] = useState(100);
  const [showCurrent, setShowCurrent] = useState(false);
  const discardCandidate = () => { setShowCurrent(false); onDiscardCutout(); };
  const [mode, setMode] = useState<ArtworkCutoutMode>(unit.cutoutMode ?? 'auto');
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; closeButton.current?.focus(); return () => previous?.focus(); }, []);
  const artwork = unit.artwork!;
  const candidate = cutoutSession?.result.status === 'completed' && cutoutSession.result.url && cutoutSession.purpose !== 'component' && !cutoutSession.stale ? cutoutSession.result : null;
  const needsLayerPreview = Boolean(candidate && artwork.draft && cutoutSession?.purpose !== 'generated');
  const previewKey = `${candidate?.receipt.jobKey}:${artwork.validation.sha256}`;
  const [preview, setPreview] = useState<{ key: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    if (!candidate || !artwork.draft || cutoutSession?.purpose === 'generated') return;
    let cancelled = false, previewUrl: string | undefined;
    void cutoutReplacementDraft(artwork.draft, candidate).then(draft => artworkPngFile(draft, 'cutout-preview.png')).then(file => {
      if (cancelled) return;
      previewUrl = URL.createObjectURL(file); setPreview({ key: previewKey, url: previewUrl });
    }).catch(error => { if (!cancelled) setPreview({ key: previewKey, error: error instanceof Error ? error.message : String(error) }); });
    return () => { cancelled = true; if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [candidate, artwork.draft, cutoutSession?.purpose, previewKey]);
  const candidatePreview = needsLayerPreview ? preview?.key === previewKey ? preview.url : undefined : candidate?.url;
  const receipt = candidate?.receipt ?? artwork.draft?.preprocessing.cutout;
  const resultUrl = candidate && !showCurrent ? candidatePreview : artwork.url;
  const originalUrl = receipt?.sourceUrl ?? source.materials.find(material => material.id === unit.materialId)?.url ?? source.materials.find(material => material.id === unit.materialId)?.previewUrl;
  const issues = artworkAcceptanceIssues(artwork.validation);
  const qualityReady = issues.length === 0;
  const advice = artworkQualityAdvice(artwork.validation);
  return <div className="wps-review-backdrop"><section className="wps-review-dialog wps-artwork-review-dialog" role="dialog" aria-modal="true" aria-labelledby="wps-review-title" onKeyDown={event => { if (event.key === 'Escape') close(); if (event.key === 'Tab') { const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary,select:not(:disabled)')).filter(el => el.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }}>
    <header><div><small>{unit.garmentLabel} · {unit.variantLabel}</small><h2 id="wps-review-title">{candidate ? '新抠图结果 · 等待选用' : '原图与抠图结果'}</h2></div><button ref={closeButton} type="button" onClick={close}>关闭</button></header>
    <div className="wps-review-body">
      <div className="wps-cutout-canvas">
        <div className="wps-cutout-toolbar"><div>{[['compare', '原图对比'], ['result', '仅看结果']].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</div><div><button type="button" aria-label="缩小图案" disabled={zoom <= 100} onClick={() => setZoom(zoom - 50)}>−</button><span>{zoom}%</span><button type="button" aria-label="放大图案" disabled={zoom >= 300} onClick={() => setZoom(zoom + 50)}>＋</button></div></div>
        <div className={`wps-cutout-comparison ${view === 'result' ? 'only-result' : ''}`}>
          {view === 'compare' && <figure><figcaption>抠图前原图</figcaption><div className="wps-cutout-viewport white">{originalUrl ? <Image src={originalUrl} alt="抠图前原图" width={1536} height={1024} unoptimized style={{ width: `${zoom}%`, height: `${zoom}%` }} /> : <p>历史图案未保存原图</p>}</div></figure>}
          <figure><figcaption>{candidate && !showCurrent ? '新抠图结果' : '当前图案'}<span>透明 PNG</span></figcaption><div className={`wps-cutout-viewport ${background}`}>{resultUrl ? <Image src={resultUrl} alt={candidate && !showCurrent ? '新抠图结果' : '当前图案'} width={1536} height={1024} unoptimized style={{ width: `${zoom}%`, height: `${zoom}%` }} /> : <p>{preview?.key === previewKey && preview.error || '正在预览保留现有文字与排版的新图案…'}</p>}</div></figure>
        </div>
        <div className="wps-review-backgrounds">换底检查 { [['checker', '透明格'], ['white', '白底'], ['blue', '蓝底'], ['black', '深色底']].map(([value, label]) => <button key={value} type="button" aria-pressed={background === value} onClick={() => setBackground(value)}>{label}</button>)}</div>
        <p className="wps-cutout-inspection">重点检查：细笔画断裂 · 文字内孔残底 · 徽章白底误删 · 换底后的白边</p>
        {candidate && <button type="button" onClick={() => setShowCurrent(!showCurrent)}>{showCurrent ? '查看新结果' : '查看当前版本'}</button>}
        <details><summary>查看客户素材与参考图</summary><div className="wps-review-sources">{source.materials.filter(material => material.id === unit.materialId || unit.referenceMaterialIds.includes(material.id)).map(material => <figure key={material.id}><div><Image src={(material.url ?? material.previewUrl)!} alt={material.name} fill sizes="200px" unoptimized /></div><figcaption>图{source.materials.indexOf(material) + 1} · {material.id === unit.materialId ? '内容来源' : '仅作参考'}</figcaption></figure>)}</div></details>
      </div>
      <div className="wps-review-details">
        <h3>{candidate ? '新抠图结果' : '当前图案'}</h3>
        {receipt ? <div className="wps-cutout-receipt"><p>抠图方式 <strong>{CUTOUT_ROUTE_LABELS[receipt.route]}</strong></p><p>抠图费用 <strong>{cutoutFeeLabel(receipt)}</strong></p><small>{receipt.reasons.join(' · ')}</small></div> : <p>历史结果未记录抠图方式与积分。</p>}
        {cutoutSession && <CutoutTaskStatus session={cutoutSession} busy={busy} query={onQueryCutout} retry={() => onReCutout(mode)} discard={discardCandidate} />}
        {!cutoutSession && <section className="wps-cutout-redo"><h3>需要重新抠图？</h3><CutoutModes value={mode} change={setMode} disabled={busy} /><p>使用保留的抠图前原图，不重新生图。当前版本保留，选用新结果后才替换。</p><small>{mode === 'standard' ? '简单底色本地免费处理；火山按服务账单计费。' : mode === 'meitu' ? '美图预计 1 积分；命中缓存不再调用。' : '简单底色本地处理；普通孔洞及复杂背景用火山，纯色背景中的细小细节、细笔画或低对比度图案用美图。'}</small><button type="button" disabled={busy} onClick={() => onReCutout(mode)}>仅重新抠图</button><CutoutRules /></section>}
        <h3>制作要求</h3><p className="wps-preserve-lines">{unit.instruction}</p>
        <p>请对照原图核对图形、文字、颜色和排版。</p>
        <p className={`wps-artwork-status ${!qualityReady ? 'needs-attention' : unit.gateB ? 'complete' : ''}`}>{!qualityReady ? '图案制作有待完成项' : unit.gateB ? '图案已确认' : '随整件效果核对'}</p>
        {!qualityReady && <ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        <details><summary>画质参考（可选，不影响保存与确认）</summary><button type="button" disabled={busy} onClick={onCheckQuality}>获取画质参考</button>{artwork.validation.quality || artwork.validation.qualityError ? <ul>{advice.map(item => <li key={item}>{item}</li>)}</ul> : <p>尚未评分，可直接人工核对。</p>}</details>
        <details className="wps-review-records"><summary>处理记录与检查详情</summary><small>{new Date(artwork.createdAt).toLocaleString()} · {artwork.validation.width} × {artwork.validation.height}px</small>{artwork.draft?.preprocessing.cutoutRuns?.map((run, index) => <p key={`${run.jobKey}-${index}`}>抠图步骤 {index + 1}：{CUTOUT_ROUTE_LABELS[run.route]} · {cutoutFeeLabel(run)}</p>)}<WpsArtworkRouting unit={unit} source={source}/></details>
        <details className="wps-review-records"><summary>检查文字</summary><LogoTextVerification key={artwork.validation.sha256} title="文字识别与逐字核对" logoName={artwork.name} logoUrl={artwork.url} initialExpectedText={artwork.textVerification?.expectedText ?? unit.exactText} initialResult={artwork.textVerification} onResult={onSaveTextCheck}/></details>
        <details className="wps-review-records"><summary>客户原文</summary><p className="wps-preserve-lines">{source.requirementText}</p></details>
        <details className="wps-review-records"><summary>调用与费用记录（{unit.attempts.length} 次）</summary>{unit.attempts.map(attempt => <section key={attempt.id}><strong>{attempt.service} · {attempt.status}</strong><p>{attempt.requestSummary}</p><p>费用：{attempt.actualCostCny === null ? '供应商未回传' : `¥${attempt.actualCostCny.toFixed(2)}`} · {new Date(attempt.createdAt).toLocaleString()}</p>{attempt.error && <p role="alert">{attempt.error}</p>}{attempt.prompt && <details><summary>本次提示词 · {attempt.promptHash}</summary><pre>{attempt.prompt}</pre></details>}</section>)}</details>
      </div>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <footer><span>{candidate ? '选用后更新图案，整件效果需重新合成和核对。' : '图案随整件效果统一核对。'}</span><div>{candidate ? <><button type="button" disabled={busy} onClick={discardCandidate}>保留当前版本</button><button type="button" className="primary" disabled={busy || !candidatePreview} onClick={onApplyCutout}>使用这版抠图</button></> : <><a href={artwork.url} download={artwork.name}>下载透明 PNG</a><button type="button" disabled={busy} onClick={edit}>编辑图案</button><button className="primary" type="button" onClick={close}>返回生产台</button></>}</div></footer>
  </section></div>;
}
