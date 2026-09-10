'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import type { ArtworkCutoutDecision, ArtworkCutoutMode, ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { ARTWORK_CUTOUT_VERSION, CUTOUT_ROUTE_LABELS, cutoutFeeLabel } from '@/lib/artwork-cutout';
import type { CutoutSession } from '@/lib/client/artwork-cutout-sessions';
export type { CutoutSession } from '@/lib/client/artwork-cutout-sessions';

export function CutoutModes({ value, disabled, change }: { value: ArtworkCutoutMode; disabled?: boolean; change: (mode: ArtworkCutoutMode) => void }) {
  return <div className="wps-cutout-modes" role="group" aria-label="抠图方式">{(['auto', 'standard', 'meitu'] as const).map(mode => <button type="button" key={mode} aria-pressed={mode === value} disabled={disabled} onClick={() => change(mode)}>{{ auto: '自动', standard: '标准', meitu: '美图精细' }[mode]}</button>)}</div>;
}
export function CutoutRules() {
  return <details className="wps-cutout-rules"><summary>怎样自动选择？</summary><p>合格透明图直接复用；简单实心图本地去底；普通镂空或背景不均匀时用火山；均匀背景中检测到小字、分散细节、细笔画或低反差时，自动选美图精细。</p><p>手选“标准”保留本地／火山路线，不强制升级美图。本地处理检查失败时，使用原图尝试火山一次；服务商失败不自动换另一家。火山与美图都保护完整圆形徽章的原图底色，并检查实际结果。断框、异形和无法确认的白色仍需对照原图核对。</p></details>;
}
const decisions = new Map<string, Promise<ArtworkCutoutDecision>>();
export async function cutoutInputDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法读取抠图前原图');
  const blob = await response.blob();
  if (blob.size > 12_000_000) throw new Error('原图超过 12MB，请先缩小输入');
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('原图读取失败')); reader.readAsDataURL(blob); });
}
export async function cutoutRequest(body: Record<string, unknown>): Promise<ArtworkCutoutResult> {
  const response = await fetch('/api/wps-production/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '抠图请求失败'); return result;
}
export function WpsCutoutControls({ mode, sourceUrl, generated, busy, change }: { mode: ArtworkCutoutMode; sourceUrl?: string | null; generated?: boolean; busy: boolean; change: (mode: ArtworkCutoutMode) => void }) {
  const [inspection, setInspection] = useState<{ key: string; value: ArtworkCutoutDecision } | null>(null);
  const decisionKey = JSON.stringify([ARTWORK_CUTOUT_VERSION, sourceUrl, mode]);
  const decision = !generated && inspection?.key === decisionKey ? inspection.value : null;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sourceUrl || generated) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      if (!decisions.has(decisionKey)) decisions.set(decisionKey, (async () => {
        const image = await cutoutInputDataUrl(sourceUrl);
        const response = await fetch('/api/wps-production/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspect', image, mode }) });
        if (!response.ok) throw new Error('分流预检暂不可用'); return response.json();
      })());
      void decisions.get(decisionKey)!.then(result => { if (!cancelled) setInspection({ key: decisionKey, value: result }); }).catch(() => { decisions.delete(decisionKey); });
    });
    if (root.current) observer.observe(root.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [sourceUrl, generated, mode, decisionKey]);
  const route = decision?.route === 'reuse' ? 'reuse' : mode === 'meitu' ? 'meitu' : decision?.route;
  return <div className="wps-cutout-settings" ref={root}><strong>抠图方式</strong>{route !== 'reuse' && <CutoutModes value={mode} disabled={busy} change={change} />}
    <div className="wps-cutout-recommendation"><b>{route ? `${mode === 'auto' ? '自动采用' : '本次采用'} · ${CUTOUT_ROUTE_LABELS[route]}` : generated ? '生成后按实际图案判断' : '制作时检查背景与细节'}</b>
      <span>{route === 'volcano' ? '按火山服务账单计费' : route === 'meitu' ? '预计 1 积分' : route ? '本地处理 0 积分；需火山时另计' : '本地免费；火山按账单计费；美图预计 1 积分'}</span>
      <p>{route === 'reuse' ? '已有透明背景，避免重复抠图。' : mode === 'standard' ? '简单底色本地处理，其余使用火山模型；不自动切换美图。' : mode === 'meitu' ? '使用美图抠图并核对结果；已识别的完整圆形徽章保留原图底色。' : decision?.reasons.join(' · ') || '简单图本地处理，普通镂空或复杂背景用火山，小字、细笔画等精细风险用美图。'}</p>
    </div><small>仅抠图费用；增强、生图另计，实际扣费以账单回执为准。</small><CutoutRules /></div>;
}
export function CutoutTaskStatus({ session, busy, query, retry, apply, discard, hasArtwork = true }: { session: CutoutSession; busy: boolean; query: () => void; retry: () => void; apply?: () => void; discard: () => void; hasArtwork?: boolean }) {
  const { result } = session;
  const component = session.purpose === 'component';
  const waiting = result.status === 'pending' || result.status === 'unknown';
  const title = result.status === 'completed' ? session.stale ? '先前制作的抠图素材' : component ? '抠图已完成，图案制作未完成' : hasArtwork ? session.purpose === 'generated' ? '完整图案已完成，待选用' : '重新抠图已完成，待选用' : '抠图已完成，待保存图案'
    : { pending: '抠图仍在处理中', failed: '这次抠图未完成', unknown: '提交结果待核实' }[result.status];
  return <div className="wps-cutout-task" role="status"><strong>{title}</strong>
    {session.stale && <p>这次任务之后，图案、要求或状态已变化。素材可查看或下载，请在编辑器中核对后使用。</p>}
    <p>{result.error || (result.status === 'completed' ? component
      ? '这是上次制作中断时保留的同一次抠图结果，完整图案尚未由这次流程保存。可下载素材，在图层编辑器中继续制作。'
      : session.stale ? '保留这次素材供核对，当前图案继续显示。' : hasArtwork ? '选用后才更新当前图案。' : '保存后才会成为当前图案。'
      : result.status === 'failed' ? session.stale ? '本次任务已失败，可关闭提示后按当前要求制作。' : '本次任务明确失败，可手动重试。' : '已保留原任务，查询只获取这次结果，不重新提交抠图。')}</p>
    <small>{CUTOUT_ROUTE_LABELS[result.receipt.route]} · {cutoutFeeLabel(result.receipt)}</small>
    {result.candidate && <CutoutCandidateComparison result={result} />}
    <div>{waiting && <button disabled={busy} type="button" onClick={query}>查询本次结果</button>}{result.status === 'failed' && !session.stale && <button disabled={busy} type="button" onClick={retry}>重试抠图</button>}
      {result.status === 'completed' && result.url && (component || session.stale) && <a href={result.url} download>下载抠图素材</a>}
      {result.status === 'completed' && result.url && apply && !component && !session.stale && <button className="primary" disabled={busy} type="button" onClick={apply}>{hasArtwork ? '使用这版抠图' : '保存为当前图案'}</button>}
      {!waiting && <button disabled={busy} type="button" onClick={discard}>{component || session.stale || !hasArtwork ? '关闭这条提示' : '保留当前版本'}</button>}
    </div><details><summary>任务记录</summary><small>任务：{result.receipt.taskId || result.receipt.jobKey}</small></details></div>;
}

export function CutoutCandidateComparison({ result }: { result: ArtworkCutoutResult }) {
  const candidate = result.candidate;
  if (!candidate) return null;
  return <details open><summary>查看返回图与疑点位置</summary>
    <p>{candidate.missingRegions.length ? '橙框标出了疑似缺失的位置，请对比原图与返回图。' : '已保留本次返回图，检查未通过，尚未作为成品使用。'}</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
      {[{ label: '抠图前原图', url: result.receipt.sourceUrl }, { label: '本次返回图', url: candidate.url }].map(item => <figure key={item.label} style={{ margin: 0 }}>
        <figcaption>{item.label}</figcaption><a href={item.url} target="_blank" rel="noreferrer" aria-label={`放大${item.label}`} style={{ display: 'block', width: '100%' }}>
          <div style={{ position: 'relative', background: '#e8e8e8', aspectRatio: `${candidate.width} / ${candidate.height}` }}>
            <Image src={item.url} alt={item.label} fill unoptimized sizes="240px" style={{ objectFit: 'contain' }} />
            {candidate.missingRegions.length > 0 && <svg aria-label="疑似缺失区域" viewBox={`0 0 ${candidate.width} ${candidate.height}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {candidate.missingRegions.map((region, index) => <rect key={index} x={Math.max(0, region.left - 3)} y={Math.max(0, region.top - 3)} width={region.width + 6} height={region.height + 6} fill="none" stroke="#e76700" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
            </svg>}
          </div>
        </a>
      </figure>)}
    </div><a href={candidate.url} download="cutout-candidate.png">下载本次返回图</a>
  </details>;
}
