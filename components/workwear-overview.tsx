'use client';
import { normalizeGarmentChecks } from '@/lib/garment-readiness-view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkwearDiagnostics, DiagnosticOrder, DiagnosticUnit } from '@/lib/workwear-diagnostics';
import type { PublicAnalysisProposal } from '@/lib/artwork-analysis-proposal';
import { safeErrorText } from '@/lib/artwork-reliability';
import './workwear-overview.css';

type BatchCheck = { target: 'artwork' | 'mockup'; unitIds: string[]; reviewToken: string; eligible: number; results: Array<{ unitId: string; blockers: string[]; garmentIssue?: string | null; calibrationUrl?: string; garmentChecks?: Array<{ unitId: string; label: string; garmentIssue: string | null; calibrationUrl: string }> }> };
type Submission = { results?: Array<{ unitId: string; id?: string; existing?: boolean; error?: string }> };
const placementLabels: Record<string, string> = { leftChest: '左胸', rightChest: '右胸', frontCenter: '正面', back: '后背', leftSleeve: '左袖', rightSleeve: '右袖' };
const stepLabels: Record<string, string> = { queued: '排队', running: '处理中', completed: '完成', failed: '未完成', unknown: '待核实', review: '待核对' };
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(310_000) });
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result ? String(result.error) : `请求失败（${response.status}）`);
  return result as T;
}
export function WorkwearOverview() {
  const [data, setData] = useState<WorkwearDiagnostics | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(''), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [checks, setChecks] = useState<BatchCheck[] | null>(null), [proposal, setProposal] = useState<PublicAnalysisProposal | null>(null);
  const [target, setTarget] = useState<'artwork' | 'mockup'>('mockup');
  const [selected, setSelected] = useState<string[]>([]);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback((signal?: AbortSignal) => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const work = (async () => {
      try {
        const payload = await api<WorkwearDiagnostics>('/api/wps-production/diagnostics');
        setData(payload); if (!signal?.aborted) setError('');
      } catch (caught) { if (!signal?.aborted) setError(`读取未完成：${safeErrorText(caught)}`); }
    })().finally(() => { if (refreshInFlight.current === work) refreshInFlight.current = null; });
    refreshInFlight.current = work;
    return work;
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    return () => abort.abort();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (!busy && document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  const orders = useMemo(() => (data?.orders ?? []).filter(order => {
    if (query && !`${order.customer} ${order.id} ${order.requirement} ${order.units.map(unit => unit.garmentLabel).join(' ')}`.toLowerCase().includes(query.toLowerCase())) return false;
    const blocked = order.needsAnalysis || order.units.some(unit => unit.blockers.length || unit.garmentIssue || unit.job?.status === 'failed' || unit.job?.status === 'unknown');
    return filter === 'all' || filter === 'blocked' && blocked || filter === 'review' && order.units.some(unit => unit.artwork && !unit.artwork.confirmed)
      || filter === '待领取' && order.status.includes('待领取') || filter === '设计中' && order.status.includes('设计中');
  }), [data, query, filter]);
  async function run(label: string, task: () => Promise<void>) {
    if (busy) return; setBusy(label); setError(''); setNotice('');
    try { await task(); }
    catch (caught) { setError(`${safeErrorText(caught)}。提交途中断网不代表没有入队，请先刷新记录，不要反复提交。`); }
    finally { setBusy(''); await refresh(); }
  }
  function openProposal(next: PublicAnalysisProposal) { setProposal(next); setSelected([]); }
  const batch = () => run('正在预检当前筛选', async () => {
    const ids = orders.flatMap(order => order.units.filter(unit => !unit.artwork).map(unit => unit.id));
    if (!ids.length) { setNotice('当前筛选没有待制作图稿；已保存图稿请核对或只重合成。'); return; }
    const batches: BatchCheck[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const unitIds = ids.slice(i, i + 100);
      const checked = await api<Omit<BatchCheck, 'unitIds' | 'target'>>('/api/wps-production/preflight', { action: 'check', target, unitIds });
      batches.push({ ...checked, target, unitIds });
    }
    setChecks(batches);
  });
  const submitBatch = () => run('正在提交已预检位置', async () => {
    if (!checks) return;
    let accepted = 0, existing = 0; const failed: string[] = [];
    // Keep the preflight tokens until a response is known; server-side dedup protects repeated clicks.
    for (const checked of checks.filter(item => item.eligible)) {
      const result = await api<Submission>('/api/wps-production/preflight', { action: 'enqueue', target: checked.target, unitIds: checked.unitIds, reviewToken: checked.reviewToken });
      if (!result.results) throw new Error('提交回执不完整，请刷新后台任务核对');
      for (const row of result.results) { if (row.error) failed.push(`${row.unitId}：${row.error}`); else if (row.existing) existing++; else if (row.id) accepted++; }
    }
    setChecks(null); setNotice(`新入队 ${accepted} 项；复用已有任务 ${existing} 项。${failed.length ? `未提交 ${failed.length} 项：${failed.join('；')}` : ''}`);
  });
  const reanalyze = (order: DiagnosticOrder) => run('正在重新分析，仅生成差异方案', async () => {
    if (!window.confirm('将调用现有需求分析模型，可能产生分析费用；不会生图、不会覆盖旧要求。继续？')) return;
    const result = await api<{ proposal: PublicAnalysisProposal }>('/api/wps-production/reanalyze', { action: 'preview', recordId: order.id }); openProposal(result.proposal);
  });
  const applyProposal = () => run('正在应用人工选择的差异', async () => {
    if (!proposal || !selected.length) return;
    if (!window.confirm('只更新所选位置。旧图与确认记录保留为历史；共享图稿或已确认成品会拒绝直接覆盖。继续？')) return;
    await api('/api/wps-production/reanalyze', { action: 'apply', proposalId: proposal.id, unitIds: selected });
    setProposal(null); setNotice('所选要求已更新。没有自动生图，请重新预检后制作。');
  });
  const recompose = (id: string) => run('仅重新合成，不生图不抠图', async () => {
    const result = await api<{ results: Array<{ status: string; error?: string }> }>('/api/wps-production/recompose', { versionIds: [id] });
    const failed = result.results.find(item => item.status !== 'ready'); if (failed) throw new Error(failed.error || '合成未完成');
    setNotice('效果图已重新合成；原图稿保持不变，请在完整编辑台确认。');
  });
  const recover = (unit: DiagnosticUnit) => run('正在恢复原任务', async () => {
    const job = unit.job; if (!job) return;
    if (job.recovery.action === 'changeCutoutMethod' && job.failedCutoutKey) {
      const value = window.prompt('复用原任务已经完成的生图步骤，仅为失败抠图创建新尝试。请输入 auto、standard 或 meitu；会产生所选抠图服务费用。', 'meitu');
      if (!value) return; if (!['auto', 'standard', 'meitu'].includes(value)) throw new Error('抠图方式只能是 auto、standard、meitu');
      if (!window.confirm('确认可能产生新的抠图费用？原生图不会因本操作重新购买；如付费提交未知，服务端会拒绝重提。')) return;
      await api('/api/wps-production/recover-cutout', { id: job.id, failedKey: job.failedCutoutKey, requestId: crypto.randomUUID(), mode: value, confirmCharge: true });
    } else if (job.recovery.action === 'retry') {
      if (job.recovery.mayCharge && !window.confirm('尚无完整的生图成功回执；只有未提交/明确失败步骤可以继续，可能发生服务费用。继续？')) return;
      await api('/api/wps-production/jobs', { action: 'retry', id: job.id });
    } else { setNotice(job.recovery.reason); return; }
    setNotice('恢复请求已提交，请看同一任务的后台进度。');
  });
  function downloadDiagnostics() {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `workwear-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return <main className="ww-overview">
    <header><div><p className="ww-eyebrow">工作服生产台 / 精简总览</p><h1>先看结果，只处理有问题的订单</h1><p>原来的选款、位置、图案编辑、确认和导出，仍在完整编辑台保留。</p></div><a className="ww-link" href="/wps-production">返回完整编辑台</a></header>
    <section className="ww-toolbar" aria-label="筛选与批量操作"><input aria-label="搜索订单" placeholder="搜索客户、款号、要求或订单ID" value={query} onChange={e => { setQuery(e.target.value); setChecks(null); }} />
      <select aria-label="订单筛选" value={filter} onChange={e => { setFilter(e.target.value); setChecks(null); }}><option value="all">全部待领取 / 设计中</option><option>待领取</option><option>设计中</option><option value="blocked">有阻塞 / 失败</option><option value="review">图稿待确认</option></select>
      <select aria-label="制作范围" disabled={!!busy} value={target} onChange={e => { setTarget(e.target.value as 'artwork' | 'mockup'); setChecks(null); }}><option value="mockup">制作图案并上衣</option><option value="artwork">仅制作独立图案</option></select>
      <button disabled={!!busy} onClick={() => void refresh()}>刷新快照</button><button disabled={!!busy || !data} onClick={() => void batch()}>预检当前筛选的待制作位置</button><button disabled={!data} onClick={downloadDiagnostics}>导出诊断</button></section>
    {busy && <p className="ww-notice" role="status">{busy}……离开页面不会取消已经入队的后台任务。</p>}
    {error && <p className="ww-error" role="alert">{error}</p>}{notice && <p className="ww-notice" role="status">{notice}</p>}
    {data && <section className="ww-summary"><strong>当前显示 {orders.length} / {data.counts.activeOrders} 条活动订单</strong><span>服务器保存了 {data.counts.allStoredOrders} 条订单</span><span>后台：{data.worker.online ? '在线' : '未确认在线'}</span><small>快照时间：{data.stateUpdatedAt}。并非本次实时WPS读取；新制作提交前会再次校验。</small><details><summary>版本与诊断说明</summary><p>网页逻辑：{data.web.logicVersion}；构建：{data.web.commit ?? '未提供构建提交号'}</p><p>最近观察到的执行版本：{data.worker.lastObservedExecutionBuild?.logicVersion ?? '尚未观察到新后台执行记录'}。这不是实时worker版本探测。</p>{data.warnings.map((item, i) => <p key={i}>{item}</p>)}</details></section>}
    {checks && <section className="ww-panel"><h2>预检结果 · {checks[0]?.target === 'artwork' ? '仅制作独立图案' : '制作图案并上衣'}</h2><p>可提交 {checks.reduce((sum, item) => sum + item.eligible, 0)} 个位置；仅入队后才开始调用制作服务。阻塞项不会假装提交成功。</p>
      {normalizeGarmentChecks(checks.flatMap(item => item.results)).map(item => <p className="ww-error" key={`garment-${item.unitId}`}>{item.label} · 上衣条件：{item.garmentIssue}。独立图案仍可制作。 <a href={item.calibrationUrl}>核对该款色衣身宽度</a></p>)}
      <details><summary>查看逐位置阻塞</summary>{checks.flatMap(item => item.results).filter(item => item.blockers.length).map(item => <p key={item.unitId}><strong>{item.unitId}</strong>：{item.blockers.join('；')}</p>)}</details>
      <button disabled={!!busy || !checks.some(item => item.eligible)} onClick={() => void submitBatch()}>确认提交这些位置（可能产生制作费用）</button><button disabled={!!busy} onClick={() => setChecks(null)}>取消本次批量</button></section>}
    {proposal && <section className="ww-panel" aria-label="旧订单分析差异"><h2>旧订单差异 · 尚未应用</h2>{proposal.warnings.map((item, i) => <p key={i}>{item}</p>)}
      {proposal.changes.map(change => <details key={change.unitId}><summary><label><input type="checkbox" disabled={!!busy} checked={selected.includes(change.unitId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, change.unitId] : ids.filter(id => id !== change.unitId))} />{change.label} · {change.differences.length} 个字段变化</label></summary>
        {change.differences.map(diff => <div className="ww-diff" key={diff.field}><strong>{diff.field}</strong><p>原：{typeof diff.before === 'string' ? diff.before : JSON.stringify(diff.before)}</p><p>新：{typeof diff.after === 'string' ? diff.after : JSON.stringify(diff.after)}</p></div>)}</details>)}
      {proposal.unmatched.map((item, i) => <p className="ww-error" key={i}>{item}</p>)}<button disabled={!!busy || !selected.length} onClick={() => void applyProposal()}>仅应用所选位置，保留旧稿历史</button><button disabled={!!busy} onClick={() => setProposal(null)}>暂不修改</button></section>}
    {!data && !error && <p role="status">正在读取服务器快照……</p>}
    {data && !orders.length && <p>当前筛选没有订单；可调整筛选或去完整编辑台同步WPS。</p>}
    <div className="ww-orders">{orders.map(order => <article className="ww-order" key={order.id}><div className="ww-order-top"><div><span className="ww-badge">{order.status}</span><h2>{order.customer || order.id}</h2><small>{order.id}</small><p className="ww-clamp">{order.requirement || '尚未填写要求'}</p></div><div className="ww-previews">{order.versions.slice(0, 4).map(version => <figure key={version.id}>{version.url ? <picture><img src={version.url} alt={`${version.label} ${version.current ? '当前效果图' : '旧预览'}`} loading="lazy" /></picture> : <div className="ww-image-empty">尚无当前预览</div>}<figcaption>{version.label}<br />{version.confirmed ? '已有确认版本' : version.current ? '预览已更新，待确认' : '预览未就绪 / 旧版'} · {version.readyPositions}/{version.totalPositions} 处有图稿</figcaption></figure>)}</div></div>
      <div className="ww-actions">{order.needsAnalysis ? <a href="/wps-production">到完整编辑台分析新增订单</a> : <button disabled={!!busy} onClick={() => void reanalyze(order)}>重新分析并对比，不直接覆盖</button>}{order.pendingProposal && <button disabled={!!busy} onClick={() => openProposal(order.pendingProposal!)}>查看已保存差异</button>}{order.versions.filter(version => !version.confirmed && version.readyPositions === version.totalPositions).map(version => <button disabled={!!busy} key={version.id} onClick={() => void recompose(version.id)}>仅重合成：{version.label}</button>)}</div>
      {order.units.some(unit => unit.blockers.length || unit.garmentIssue || unit.job?.error) && <p className="ww-error">{[...new Set(order.units.flatMap(unit => [...unit.blockers, ...(unit.garmentIssue ? [unit.garmentIssue] : []), ...(unit.job?.error ? [unit.job.error] : [])]))].slice(0, 3).join('；')}。完整信息在下方详情。</p>}
      {order.units.filter(unit => unit.garmentIssue).map(unit => <p className="ww-error" key={`calibration-${unit.id}`}>{unit.garmentLabel} · {placementLabels[unit.placement] ?? unit.placement}：上衣暂不可用，图稿可保留或独立制作。 <a href={unit.calibrationUrl ?? '/products'}>打开该款色核对衣身宽度与位置</a></p>)}
      {order.units.some(unit => unit.temporaryPlacement && !unit.garmentIssue) && <p>上衣使用临时预览位置，尚未人工确认；图稿生成后再按实际边界核对尺寸与位置。</p>}
      <details><summary>查看 {order.units.length} 个印花位置、原文及处理详情</summary><p className="ww-source">原文：{order.requirement}</p>{order.units.map(unit => <section className="ww-unit" key={unit.id}><div><h3>{unit.garmentLabel} · {placementLabels[unit.placement] ?? unit.placement}</h3><p>{unit.artwork ? `${unit.artwork.confirmed ? '图稿已确认' : '图稿已保存待核对'} · ${unit.artwork.sha256.slice(0, 12)}` : '尚无已保存图稿'}{!unit.analysisCurrent ? '；旧解析版本，建议对比核对' : ''}</p><p>输入：{unit.inputs.map(image => `${image.sourceLabel}（${image.roles.join('/')}）`).join('、') || '无图片或待绑定'}</p></div>
        {unit.blockers.length > 0 && <p className="ww-error">要求阻塞：{unit.blockers.join('；')}</p>}{unit.garmentIssue && <p className="ww-error">上衣阻塞：{unit.garmentIssue}。已保存图稿不需重做。</p>}
        {unit.job && <><p>后台任务 {unit.job.id.slice(0, 8)}：{stepLabels[unit.job.status] ?? unit.job.status} · {unit.job.message}</p>{unit.job.error && <p className="ww-error">{unit.job.error}</p>}<p>{unit.job.recovery.reason}</p>{(unit.job.recovery.action === 'retry' || unit.job.recovery.action === 'changeCutoutMethod' && unit.job.failedCutoutKey) && <button disabled={!!busy} onClick={() => void recover(unit)}>{unit.job.recovery.action === 'changeCutoutMethod' ? '复用原生图，显式重试失败抠图' : unit.job.recovery.label}</button>}
        <details><summary>具体步骤与失败记录</summary>{unit.job.steps.map((step, i) => <p key={i}>{step.label}：{stepLabels[step.status] ?? step.status}{step.error ? ` · ${step.error}` : ''}</p>)}</details></>}
      </section>)}</details>
    </article>)}</div>
  </main>;
}
