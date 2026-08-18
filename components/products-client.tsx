'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AppHeader } from '@/components/app-header';
import { ProductGrid } from '@/components/product-grid';
import { useDemoState } from '@/hooks/use-demo-state';
import { createTask } from '@/lib/mockup';
import { productByCode } from '@/lib/products';

type ProductsClientProps = {
  mode: 'append' | 'replace';
  taskId: string | null;
};

export function ProductsClient({ mode, taskId }: ProductsClientProps) {
  const router = useRouter();
  const { state, saveStatus, error, reload, updateState } = useDemoState();
  const [search, setSearch] = useState('');
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const replacing = mode === 'replace';
  const task = replacing ? state?.tasks.find((candidate) => candidate.id === taskId) : null;
  const countsByCode = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const currentTask of state?.tasks ?? []) {
      counts[currentTask.productCode] = (counts[currentTask.productCode] ?? 0) + 1;
    }
    return counts;
  }, [state]);

  const toggleProduct = (code: string) => {
    setSelectedCodes((current) => {
      if (replacing) return new Set([code]);
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const confirmSelection = async () => {
    if (!state || selectedCodes.size === 0) return;
    setSubmitting(true);
    setActionError(null);
    try {
      if (replacing) {
        if (!task) throw new Error(`找不到需要更换商品的任务：${taskId ?? '空'}`);
        const productCode = [...selectedCodes][0];
        const now = new Date().toISOString();
        await updateState((current) => ({
          ...current,
          tasks: current.tasks.map((candidate) => candidate.id === task.id ? {
            ...candidate,
            productCode,
            updatedAt: now,
            exportedAt: null,
          } : candidate),
          updatedAt: now,
        }), { immediate: true });
        router.push(`/workbench?taskId=${encodeURIComponent(task.id)}`);
        return;
      }
      const newTasks = [...selectedCodes].map((code) => createTask(code));
      const now = new Date().toISOString();
      await updateState((current) => ({
        ...current,
        tasks: [...current.tasks, ...newTasks],
        updatedAt: now,
      }), { immediate: true });
      router.push(`/workbench?taskId=${encodeURIComponent(newTasks[0].id)}`);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : String(submitError));
      setSubmitting(false);
    }
  };

  if (!state && saveStatus === 'loading') {
    return <main className="loading-screen">正在读取 Demo 任务数据…</main>;
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="library-page">
        <section className="context-bar">
          <div>
            <strong>{replacing ? `为任务更换商品` : '向当前批次添加商品'}</strong>
            <span>{replacing
              ? `选择一款新衣服；${task ? `${task.productCode} 的` : ''}Logo、位置和尺寸都会保留。`
              : '选择一款或多款衣服，每款新增一条任务，原有任务不会改变。'}</span>
          </div>
          <span>当前批次 {state?.tasks.length ?? 0} 条任务</span>
        </section>

        <div className="library-toolbar">
          <div><h1>商品素材库</h1><p>10 款客户真实素材，可按产品型号、名称或颜色搜索。</p></div>
          <label className="search-field"><span className="sr-only">搜索商品</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索型号、款名或颜色" type="search" /></label>
        </div>

        {(error || actionError) && (
          <div className="error-banner">{actionError ?? error}<button type="button" onClick={() => void reload()}>重新读取</button></div>
        )}

        <ProductGrid countsByCode={countsByCode} onToggle={toggleProduct} search={search} selectedCodes={selectedCodes} />

        <footer className="sticky-actions">
          <span>已选择 {selectedCodes.size} 款{saveStatus === 'saving' ? ' · 正在保存…' : ''}</span>
          <div>
            <button className="button secondary" type="button" onClick={() => router.push('/workbench')}>取消，返回工作台</button>
            <button className="button primary" disabled={selectedCodes.size === 0 || submitting} type="button" onClick={() => void confirmSelection()}>
              {submitting ? '正在保存…' : replacing ? `替换为${selectedCodes.size ? ` ${productByCode([...selectedCodes][0])?.code}` : ''}` : `加入当前批次${selectedCodes.size ? `（${selectedCodes.size}）` : ''}`}
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}
