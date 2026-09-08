'use client';

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { useProjectSession } from '@/components/project-session';
import { useDemoState } from '@/hooks/use-demo-state';
import { createTask } from '@/lib/mockup';
import { simpleCatalogBindingSchema } from '@/lib/simple-batch';
import type { CatalogStyle } from '@/lib/catalog';
import type { MockupTask } from '@/lib/types';

type ProductsClientProps = { mode: 'append' | 'replace'; taskId: string | null };
async function jsonResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `读取素材库失败：HTTP ${response.status}`);
  return body;
}

export function ProductsClient({ mode, taskId }: ProductsClientProps) {
  const router = useRouter();
  const session = useProjectSession();
  const { state, saveStatus, error, updateState } = useDemoState();
  const [styles, setStyles] = useState<CatalogStyle[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const replacing = mode === 'replace';
  const task = replacing ? state?.tasks.find(candidate => candidate.id === taskId) : null;
  const load = useCallback(async () => {
    setLoading(true); setActionError(null);
    try { setStyles((await jsonResponse(await fetch('/api/catalog/production-garments', { cache: 'no-store' }))).styles); }
    catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!session.user) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [session.user, load]);
  const colors = session.user ? styles.flatMap(style => style.colors) : [];
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const visible = colors.filter(item => `${item.styleCode} ${item.colorName} ${item.namespace}`.toLocaleLowerCase('zh-CN').includes(query));
  const toggle = (id: string) => setSelectedIds(current => {
    if (replacing) return new Set([id]);
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const confirmSelection = async () => {
    if (!state || !selectedIds.size || !session.user) return;
    setSubmitting(true); setActionError(null);
    try {
      if (replacing && !task) throw new Error('找不到需要更换商品的任务');
      const prepared: MockupTask[] = [];
      const failures: string[] = [];
      for (const id of selectedIds) {
        const item = colors.find(item => item.id === id);
        if (!item) { failures.push('所选颜色已不在列表，请重新读取'); continue; }
        try {
          const { garment, placementDefaults } = simpleCatalogBindingSchema.parse(await jsonResponse(await fetch(`/api/catalog/simple-garment?variantId=${item.id}&assetVersionId=${item.assetVersionId}`, { cache: 'no-store' })));
          const next = { ...createTask(item.styleCode), garment, placementDefaults };
          // Keep the uploaded artwork and dimensions, but start from this garment's own anchors.
          if (task) prepared.push({ ...task, garment, placementDefaults, productCode: item.styleCode, updatedAt: next.updatedAt, exportedAt: null,
            placements: Object.fromEntries(Object.entries(task.placements).map(([key, placement]) => [key, { ...placement, offsetX: 0, offsetY: 0 }])) });
          else prepared.push(next);
        } catch (error) { failures.push(`${item.styleCode} ${item.colorName}：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (prepared.length) {
        await updateState(current => ({ ...current, updatedAt: new Date().toISOString(),
          tasks: replacing ? current.tasks.map(candidate => candidate.id === taskId ? prepared[0] : candidate) : [...current.tasks, ...prepared],
        }), { immediate: true });
        setSelectedIds(new Set([...selectedIds].filter(id => !prepared.some(task => task.garment?.variantId === id))));
      }
      if (failures.length) { setActionError(`已保存 ${prepared.length} 条，${failures.length} 条未完成：${failures.join('；')}`); return; }
      router.push(`/workbench?taskId=${encodeURIComponent(prepared[0].id)}`);
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setSubmitting(false); }
  };
  return <div className="app-shell"><AppHeader /><main className="library-page">
    <section className="context-bar"><div><strong>{replacing ? '更换衣服' : '简单批量生图 · 添加衣服'}</strong><span>{replacing ? '保留 Logo 和尺寸，位置回到新衣服的默认位置。' : '选择款式和颜色，每个颜色生成一条任务，自动带入素材库的印制位置。'}</span></div><span>当前批次 {state?.tasks.length ?? 0} 条任务</span></section>
    <div className="library-toolbar"><div><h1>从素材库选衣服</h1><p>{styles.length} 款 · {colors.length} 个颜色，可多选后加入批次。</p></div><label className="search-field"><span className="sr-only">搜索商品</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索款号、颜色" type="search" /></label></div>
    {(error || actionError) && <div className="error-banner" role="alert">{actionError ?? error}<button type="button" disabled={loading || submitting} onClick={() => void load()}>重新读取</button></div>}
    {!session.initialized ? <p>正在加载工作台…</p> : !session.user ? <div className="empty-state"><p>工作台暂时无法读取，请重试连接。</p><button className="button primary" type="button" onClick={() => void session.refresh()}>重新连接</button></div> : loading ? <p role="status">正在读取款式和颜色…</p> : <div className="product-grid">{visible.map((item, index) => <button type="button" className="product-card" aria-pressed={selectedIds.has(item.id)} aria-label={`${item.styleCode} ${item.colorName}`} disabled={submitting} key={item.id} onClick={() => toggle(item.id)}>
      <span className="product-image"><img alt={`${item.styleCode} ${item.colorName}`} src={item.thumbnailUrl} loading={index < 6 ? 'eager' : 'lazy'} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /><span className="select-indicator" aria-hidden="true">{selectedIds.has(item.id) ? '✓' : ''}</span></span>
      <strong>{item.styleCode}</strong><span>{item.colorName}</span><small>{item.confirmedFaces === item.faceCount && item.faceCount > 0 ? '已确认位置标准' : item.confirmedFaces > 0 ? '已校准与默认位置' : '可直接使用默认位置'}</small>
    </button>)}</div>}
    {session.user && !loading && !visible.length && <div className="empty-state">没有匹配的款式或颜色。</div>}
    <footer className="sticky-actions"><span>已选 {selectedIds.size} 个颜色{saveStatus === 'saving' ? ' · 正在保存…' : ''}</span><div><button className="button secondary" disabled={submitting} type="button" onClick={() => router.push('/workbench')}>返回简单批量生图</button><button className="button primary" disabled={!state || !session.user || !selectedIds.size || submitting || loading} type="button" onClick={() => void confirmSelection()}>{submitting ? '正在读取位置并保存…' : replacing ? '确认更换' : `加入当前批次（${selectedIds.size}）`}</button></div></footer>
  </main></div>;
}
