'use client';
/* Raw local PNGs preserve original pixels and Alpha; Next image transcoding is intentionally disabled. */
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState, useRef } from 'react';
import type { LocalState, StoredRun } from '../application/runtime-types';
const statuses: Record<string, string> = { queued: '等待制作', running: '制作中', completed: '已生成 · 待核对', failed: '制作中断', unknown: '提交结果待查询' };
const kinds: Record<string, string> = { 'inspect-source': '检查素材', 'select': '选取原图', 'enhance': '高清放大', 'render-text': '准确排字', 'generate': '重新生成', 'edit': '修改图形', 'cutout': '去除外底', 'compose-artwork': '合成图稿', 'review': '逐项核对', 'compose-mockup': '上衣合成' };
const asset = (id: string) => `/api/batch-mockup/assets/${id}`;
async function request(path: string, body?: unknown) { const response = await fetch(`/api/batch-mockup/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }); const result = await response.json(); if (!response.ok)
    throw new Error(result.error ?? '读取失败'); return result; }
export function Workspace() {
    const [state, setState] = useState<LocalState | null>(null), [selected, setSelected] = useState(''), [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [pending, setPending] = useState(false), [editing, setEditing] = useState<{
        orderId: string;
        revision: number;
        text: string;
    } | null>(null), [operation, setOperation] = useState<{
        key: string;
        id: string;
    } | null>(null);
    const readSequence = useRef(0);
    const refresh = useCallback(async () => { const sequence = ++readSequence.current; try {
        const latest = await request('state');
        if (sequence === readSequence.current) {
            setState(latest);
            setConnectionError('');
        }
    }
    catch (e) {
        if (sequence === readSequence.current)
            setConnectionError(String(e));
    } }, []);
    useEffect(() => { const first = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 1500); return () => { clearTimeout(first); clearInterval(timer); }; }, [refresh]);
    const filtered = state?.orders.filter(o => { const latest = state.runs.find(r => r.orderId === o.id); return `${o.title} ${o.source.requirementText}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || (filter === 'new' ? (!latest || latest.requirement.revision !== o.requirement.revision) : latest?.status === filter && latest.requirement.revision === o.requirement.revision)); }) ?? [];
    const order = filtered.find(o => o.id === selected) ?? filtered[0];
    const text = order?.requirement.artworks.flatMap(a => a.components).find(c => c.kind === 'text');
    const value = text?.kind === 'text' && text.content.kind === 'exact' ? text.content.value : '';
    const draft = editing && editing.orderId === order?.id && editing?.revision === order?.requirement.revision ? editing.text : value;
    const runs = state?.runs.filter(r => r.orderId === order?.id) ?? [], run = runs[0], active = runs.some(r => ['queued', 'running', 'unknown'].includes(r.status));
    async function act(work: () => Promise<unknown>) { if (pending)
        return; setPending(true); setError(''); try {
        await work();
        if (order) setSelected(order.id);
        setFilter("all");
        await refresh();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : String(e));
    }
    finally {
        setPending(false);
    } }
    async function make(failAt?: string) { if (!order)
        return; const key = `${order.id}:${order.requirement.revision}:${failAt ?? ''}`; const id = operation?.key === key ? operation.id : crypto.randomUUID(); setOperation({ key, id }); await act(async () => { await request('runs', { orderId: order.id, artworkId: order.requirement.artworks[0].id, expectedRevision: order.requirement.revision, operationId: id, ...(failAt ? { failAt } : {}) }); setOperation(null); }); }
    return <div className="bm-workspace"><header className="bm-header"><div><span className="bm-eyebrow">WORKWEAR / NEW WORKSPACE</span><h1>批量效果图</h1></div><span className="bm-local">本地验收版</span></header>
 <div className="bm-notice">当前使用人工标注需求、真实图片和本地排字。尚未接入 AI 看图、付费生图或正式订单；生成结果均需核对。</div>
 {connectionError && <div className="bm-error" role="alert">{connectionError}</div>}
 {error && <div className="bm-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
 <div className="bm-grid"><aside className="bm-sidebar"><div className="bm-list-head"><h2>制作清单</h2><span>{state?.orders.length ?? 0} 项</span></div><input aria-label="搜索任务" placeholder="搜索需求或任务名称" value={query} onChange={e => setQuery(e.target.value)}/><select aria-label="筛选状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option><option value="new">未开始</option><option value="completed">已生成</option><option value="failed">制作中断</option></select>
 {filtered.map(o => { const latest = state?.runs.find(r => r.orderId === o.id); return <button className={`bm-order ${order?.id === o.id ? 'is-selected' : ''}`} key={o.id} onClick={() => { setSelected(o.id); setError(''); }}><strong>{o.title}</strong><span>{latest ? (latest.requirement.revision === o.requirement.revision ? statuses[latest.status] : '要求已更新') : '未开始'} · 需求 v{o.requirement.revision}</span></button>; })}{!filtered.length && <p className="bm-muted">没有匹配的任务。</p>}</aside>
 <main className="bm-detail">{!state ? <p>正在读取本地工作台…</p> : order ? <><div className="bm-title"><div><span className="bm-eyebrow">需求 v{order.requirement.revision}</span><h2>{order.title}</h2></div><button className="bm-primary" disabled={pending || active || draft !== value} onClick={() => void make()}>{active ? '当前任务进行中' : run ? '制作新版本' : '开始制作'}</button></div>
 <section className="bm-panel"><h3>原始需求与参考素材</h3><pre>{order.source.requirementText}</pre><p className="bm-muted">{order.note}</p><div className="bm-references">{order.source.materials.map(m => <figure key={m.id}>{m.artifactId && <a href={asset(m.artifactId)} target="_blank"><img src={asset(m.artifactId)} alt={m.label}/></a>}<figcaption>{m.label} · {order.requirement.materialUses.filter(u => u.materialId === m.id).map(u => ({ content: '内容', font: '字体', color: '颜色', layout: '排版', annotation: '说明', excluded: '排除' }[u.role])).join(' / ')}</figcaption></figure>)}</div>
 <label className="bm-field">准确文字（空格和换行会保留）<textarea aria-label="准确文字" rows={3} value={draft} disabled={pending} onChange={e => setEditing({ orderId: order.id, revision: order.requirement.revision, text: e.target.value })}/></label><button disabled={pending || draft === value || !draft.trim()} onClick={() => void act(() => request('requirements', { orderId: order.id, componentId: text?.id, text: draft, expectedRevision: order.requirement.revision }))}>保存文字修改</button><span className="bm-muted"> 保存后手动制作新版本，旧图保留。</span></section>
 {run && <><section className="bm-panel"><div className="bm-title"><h3>制作过程 · {statuses[run.status]}</h3>{run.status === 'failed' && <button className="bm-primary" disabled={pending || run.requirement.revision !== order.requirement.revision} onClick={() => void act(() => request('resume', { runId: run.id }))}>从失败步骤继续</button>}</div><p className="bm-muted">此版本使用需求 v{run.requirement.revision}。{run.requirement.revision !== order.requirement.revision ? '要求已更新，当前图为旧版本。' : ''}</p>{run.error && <p className="bm-error">{run.error}</p>}<ol className="bm-steps">{[...run.plan.steps, ...(!run.plan.steps.some(s => s.kind === 'compose-mockup') ? [{ id: `${run.id}-mockup`, kind: 'compose-mockup' }] : [])].map(s => { const saved = run.steps.find(x => x.id === s.id || s.kind === 'compose-mockup' && x.kind === s.kind); return <li key={s.id} data-status={saved?.status ?? 'pending'}><span>{kinds[s.kind] ?? s.kind}</span><small>{saved?.status === 'completed' ? '完成' : saved?.status === 'failed' ? '失败' : saved?.status === 'running' ? '进行中' : '待执行'}{saved ? ` · ${saved.executions} 次` : ''}</small></li>; })}</ol>
 {run.steps.flatMap(s => s.output?.checks ?? []).length > 0 && <details open><summary>核对清单（尚未自动判定合格）</summary><ul>{run.steps.flatMap(s => s.output?.checks ?? []).map((c, i) => <li key={i}><b>{c.expected}</b> — {c.actual}</li>)}</ul></details>}</section><section className="bm-panel"><h3>生成结果</h3><div className="bm-results">{[['独立图稿', run.artworkArtifactId], ['上衣合成示意', run.mockupArtifactId]].map(([label, id]) => <figure key={label!}><div className="bm-image checker">{id ? <a href={asset(id)} target="_blank"><img src={asset(id)} alt={label!}/></a> : <span>等待输出</span>}</div><figcaption>{label}{id && <a href={`${asset(id)}?download`}>下载 PNG</a>}</figcaption></figure>)}</div><p className="bm-muted">上衣款色与位置为测试示意，尚未验收为订单效果图。点击图片可查看原尺寸。</p><details><summary>查看保留的中间图片</summary><div className="bm-candidates">{Array.from(new Set(run.steps.flatMap(s => s.output?.images.map(i => i.artifactId) ?? []))).map(id => <a key={id} href={asset(id)} target="_blank"><img src={asset(id)} alt="保留的中间图片"/></a>)}</div></details></section></>}
 {runs.length > 1 && <section className="bm-panel"><h3>历史版本</h3>{runs.slice(1).map((r: StoredRun) => <p key={r.id}>需求 v{r.requirement.revision} · {statuses[r.status]} {r.artworkArtifactId && <a href={asset(r.artworkArtifactId)} target="_blank">查看图稿</a>}</p>)}</section>}
 <details className="bm-fault"><summary>本地恢复测试</summary><p>仅对本地测试任务注入一次“上衣合成失败”，用于检查恢复时是否保留已做好的图稿。</p><button disabled={pending || active || draft !== value} onClick={() => void make('compose-mockup')}>测试一次合成中断</button></details></> : <p>暂无本地验收任务。</p>}</main></div><footer>新框架独立运行 · PostgreSQL 持久任务 · SHA-256 图片身份</footer></div>;
}
