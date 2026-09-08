'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppHeader } from '@/components/app-header';
import { LogoTextVerification } from '@/components/logo-text-verification';
import { MockupCanvas } from '@/components/mockup-canvas';
import { useDemoState } from '@/hooks/use-demo-state';
import { exportTasks } from '@/lib/client/export';
import { removeWhiteBackground, uploadLogo } from '@/lib/client/logo';
import {
  PLACEMENT_DEFAULTS,
  PLACEMENT_LABELS,
  taskStatus,
} from '@/lib/mockup';
import { simpleTaskProduct, simplePositionIssue, simpleBackPositions, simplePositionSource, simpleCatalogBindingSchema } from '@/lib/simple-batch';
import { POSITION_LABELS } from '@/lib/catalog';
import {
  PLACEMENT_KEYS,
  type LogoPlacement,
  type MockupTask,
  type PlacementKey,
  type TaskStatus,
} from '@/lib/types';

const STATUS_LABELS: Record<TaskStatus, string> = {
  waitingLogo: '待上传 Logo',
  ready: '可导出',
  exported: '已导出',
};

type DeletedTask = { task: MockupTask; index: number };

type WorkbenchClientProps = { requestedTaskId: string | null };

function changedTask(task: MockupTask, changes: Partial<MockupTask>): MockupTask {
  return {
    ...task,
    ...changes,
    updatedAt: new Date().toISOString(),
    exportedAt: null,
  };
}

export function WorkbenchClient({ requestedTaskId }: WorkbenchClientProps) {
  const { state: savedState, saveStatus, error, reload, updateState } = useDemoState();
  const [loadedDefaults, setLoadedDefaults] = useState<Record<string, NonNullable<MockupTask['placementDefaults']>>>({});
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const state = useMemo(() => savedState ? { ...savedState, tasks: savedState.tasks.map(task => task.garment && !task.placementDefaults && loadedDefaults[task.garment.assetVersionId]
    ? { ...task, placementDefaults: loadedDefaults[task.garment.assetVersionId] } : task) } : null, [savedState, loadedDefaults]);
  const missingDefaults = JSON.stringify([...new Map((savedState?.tasks ?? []).filter(task => task.garment && !task.placementDefaults && !loadedDefaults[task.garment.assetVersionId])
    .map(task => [task.garment!.assetVersionId, { variantId: task.garment!.variantId, assetVersionId: task.garment!.assetVersionId }])).values()]);
  useEffect(() => {
    const inputs: Array<{ variantId: string; assetVersionId: string }> = JSON.parse(missingDefaults);
    if (!inputs.length) return;
    let disposed = false;
    void (async () => {
      const results = await Promise.allSettled(inputs.map(async input => {
        const response = await fetch(`/api/catalog/simple-garment?variantId=${input.variantId}&assetVersionId=${input.assetVersionId}`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '默认位置读取失败');
        return [input.assetVersionId, simpleCatalogBindingSchema.parse(body).placementDefaults] as const;
      }));
      if (disposed) return;
      const loaded: typeof loadedDefaults = {};
      const failures: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') loaded[result.value[0]] = result.value[1];
        else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
      if (Object.keys(loaded).length) setLoadedDefaults(current => ({ ...current, ...loaded }));
      if (failures.length) setDefaultsError(failures.join('；'));
    })();
    return () => { disposed = true; };
  }, [missingDefaults]);
  const [preferredActiveTaskId, setPreferredActiveTaskId] = useState<string | null>(requestedTaskId);
  const [storedSelectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'all' | TaskStatus>('all');
  const [activePosition, setActivePosition] = useState<PlacementKey>('leftChest');
  const [pendingUploadPosition, setPendingUploadPosition] = useState<PlacementKey>('leftChest');
  const [message, setMessage] = useState('画布调整会自动保存，可以直接导出。');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuTaskId, setMenuTaskId] = useState<string | null>(null);
  const [deleteTaskIds, setDeleteTaskIds] = useState<string[]>([]);
  const [lastDeleted, setLastDeleted] = useState<DeletedTask[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchFile, setBatchFile] = useState<File | null>(null);
  const [batchPosition, setBatchPosition] = useState<PlacementKey>('leftChest');
  const [batchWidth, setBatchWidth] = useState(7);
  const [batchBackPosition, setBatchBackPosition] = useState<'upperBack' | 'backCenter'>('backCenter');
  const logoInputRef = useRef<HTMLInputElement>(null);

  const activeTaskId = useMemo(() => {
    const tasks = state?.tasks ?? [];
    if (preferredActiveTaskId && tasks.some((task) => task.id === preferredActiveTaskId)) {
      return preferredActiveTaskId;
    }
    if (requestedTaskId && tasks.some((task) => task.id === requestedTaskId)) {
      return requestedTaskId;
    }
    return tasks[0]?.id ?? null;
  }, [preferredActiveTaskId, requestedTaskId, state]);
  const selectedTaskIds = useMemo(() => {
    const taskIds = new Set((state?.tasks ?? []).map((task) => task.id));
    return new Set([...storedSelectedTaskIds].filter((id) => taskIds.has(id)));
  }, [state, storedSelectedTaskIds]);

  const activeTask = state?.tasks.find((task) => task.id === activeTaskId) ?? null;
  const activeProduct = activeTask ? simpleTaskProduct(activeTask) : null;
  const activePlacement = activeTask?.placements[activePosition];
  const filteredTasks = useMemo(() => (state?.tasks ?? []).filter((task) =>
    statusFilter === 'all' || taskStatus(task) === statusFilter,
  ), [state, statusFilter]);
  const exportedCount = state?.tasks.filter((task) => taskStatus(task) === 'exported').length ?? 0;

  const saveTasks = (
    transform: (tasks: MockupTask[]) => MockupTask[],
    immediate = false,
  ) => updateState((current) => ({
    ...current,
    tasks: transform(current.tasks.map(task => task.garment && !task.placementDefaults && loadedDefaults[task.garment.assetVersionId] ? { ...task, placementDefaults: loadedDefaults[task.garment.assetVersionId] } : task)),
    updatedAt: new Date().toISOString(),
  }), { immediate });

  const updateTask = (
    taskId: string,
    transform: (task: MockupTask) => MockupTask,
    immediate = false,
  ) => saveTasks((tasks) => tasks.map((task) => task.id === taskId ? transform(task) : task), immediate);

  const updatePlacement = (
    taskId: string,
    key: PlacementKey,
    transform: (placement: LogoPlacement) => LogoPlacement,
  ) => updateTask(taskId, (task) => {
    const placement = task.placements[key];
    if (!placement) return task;
    return changedTask(task, { placements: { ...task.placements, [key]: transform(placement) } });
  });

  const requestLogoUpload = (key: PlacementKey) => {
    if (activeTask) { const issue = simplePositionIssue(activeTask, key, activeTask.placements[key]); if (issue) { setActionError(issue); return; } }
    setPendingUploadPosition(key);
    setActivePosition(key);
    logoInputRef.current?.click();
  };

  const logoSelected = async (file: File | null) => {
    if (!file || !activeTask) return;
    setBusy(true);
    setActionError(null);
    try {
      const uploaded = await uploadLogo(file);
      const defaults = PLACEMENT_DEFAULTS[pendingUploadPosition];
      const issue = simplePositionIssue(activeTask, pendingUploadPosition, activeTask.placements[pendingUploadPosition]);
      if (issue) throw new Error(issue);
      await updateTask(activeTask.id, (task) => changedTask(task, {
        placements: {
          ...task.placements,
          [pendingUploadPosition]: {
            logoUrl: uploaded.url,
            logoName: uploaded.originalName,
            ...defaults,
            ...(activeTask.placements[pendingUploadPosition] ? { ...activeTask.placements[pendingUploadPosition], logoUrl: uploaded.url, logoName: uploaded.originalName } : {}),
          },
        },
      }), true);
      setMessage(`${PLACEMENT_LABELS[pendingUploadPosition]}已绑定 ${uploaded.originalName}，设置已保存。`);
    } catch (uploadError) {
      setActionError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(false);
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  const refreshStandards = async () => {
    if (!activeTask?.garment) return;
    const target = activeTask;
    setBusy(true); setActionError(null);
    try {
      const response = await fetch(`/api/catalog/simple-garment?variantId=${target.garment!.variantId}&assetVersionId=${target.garment!.assetVersionId}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '位置标准读取失败');
      const { garment, placementDefaults } = simpleCatalogBindingSchema.parse(body);
      await updateTask(target.id, task => changedTask(task, { garment, placementDefaults }), true);
      setDefaultsError(null);
      setMessage('已更新这张底图的校准与默认位置，保留当前 Logo 和微调。');
    } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const clearPlacement = async (key: PlacementKey) => {
    if (!activeTask) return;
    await updateTask(activeTask.id, (task) => {
      const placements = { ...task.placements };
      delete placements[key];
      return changedTask(task, { placements });
    }, true);
    setMessage(`已清除${PLACEMENT_LABELS[key]}的 Logo。`);
  };

  const cutoutActiveLogo = async () => {
    if (!activeTask || !activePlacement) return;
    setBusy(true);
    setActionError(null);
    try {
      const uploaded = await removeWhiteBackground(activePlacement.logoUrl, activePlacement.logoName);
      await updateTask(activeTask.id, (task) => changedTask(task, {
        placements: {
          ...task.placements,
          [activePosition]: {
            ...activePlacement,
            logoUrl: uploaded.url,
            logoName: uploaded.originalName,
          },
        },
      }), true);
      setMessage(`${PLACEMENT_LABELS[activePosition]} Logo 已去除白底并清理边缘白色。`);
    } catch (cutoutError) {
      setActionError(cutoutError instanceof Error ? cutoutError.message : String(cutoutError));
    } finally {
      setBusy(false);
    }
  };

  const exportScope = async (scope: 'current' | 'selected' | 'all') => {
    if (!state) return;
    const targets = scope === 'current'
      ? activeTask ? [activeTask] : []
      : scope === 'selected'
        ? state.tasks.filter((task) => selectedTaskIds.has(task.id))
        : state.tasks;
    if (targets.length === 0) {
      setActionError('当前导出范围内没有任务');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await exportTasks(targets);
      const exportedAt = new Date().toISOString();
      const exportedIds = new Set(result.exportedTaskIds);
      await saveTasks((tasks) => tasks.map((task) => exportedIds.has(task.id)
        ? { ...task, exportedAt, updatedAt: exportedAt }
        : task), true);
      setMessage(`已导出 ${result.exportedTaskIds.length} 条任务${result.skipped ? `，跳过 ${result.skipped} 条未上传 Logo 的任务` : ''}${result.failures.length ? `，${result.failures.length} 条失败，详见 ZIP 内清单` : ''}。`);
      if (result.failures.length) setActionError(result.failures.join('；'));
    } catch (exportError) {
      setActionError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!state || deleteTaskIds.length === 0) return;
    const targetIds = new Set(deleteTaskIds);
    const deleted = state.tasks.flatMap((task, index) => targetIds.has(task.id) ? [{ task, index }] : []);
    const remaining = state.tasks.filter((task) => !targetIds.has(task.id));
    await saveTasks(() => remaining, true);
    setLastDeleted(deleted);
    setSelectedTaskIds((current) => new Set([...current].filter((id) => !targetIds.has(id))));
    if (activeTaskId && targetIds.has(activeTaskId)) setPreferredActiveTaskId(remaining[0]?.id ?? null);
    setDeleteTaskIds([]);
    setMessage(`已删除 ${deleted.length} 条任务。`);
  };

  const undoDelete = async () => {
    if (lastDeleted.length === 0) return;
    await saveTasks((tasks) => {
      const restored = [...tasks];
      for (const item of [...lastDeleted].sort((left, right) => left.index - right.index)) {
        restored.splice(Math.min(item.index, restored.length), 0, item.task);
      }
      return restored;
    }, true);
    setPreferredActiveTaskId(lastDeleted[0].task.id);
    setSelectedTaskIds(new Set(lastDeleted.map((item) => item.task.id)));
    setMessage(`已恢复 ${lastDeleted.length} 条任务。`);
    setLastDeleted([]);
  };

  const applyBatch = async () => {
    if (!batchFile || selectedTaskIds.size === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      if (!Number.isFinite(batchWidth) || batchWidth < .5 || batchWidth > 100) throw new Error('宽度应在 0.5–100 cm 之间');
      const defaults = { ...PLACEMENT_DEFAULTS[batchPosition], ...(batchPosition === 'back' ? { catalogPosition: batchBackPosition } : {}) };
      const failures: string[] = [];
      const eligibleIds = new Set((state?.tasks ?? []).filter(task => {
        if (!selectedTaskIds.has(task.id)) return false;
        const issue = simplePositionIssue(task, batchPosition, { ...defaults, widthCm: batchWidth, logoUrl: '', logoName: '' });
        if (issue) failures.push(`${task.productCode} ${task.garment?.colorName ?? ''}：${issue}`);
        return !issue;
      }).map(task => task.id));
      if (!eligibleIds.size) throw new Error(failures.join('；'));
      const uploaded = await uploadLogo(batchFile);
      await saveTasks((tasks) => tasks.map((task) => eligibleIds.has(task.id)
        ? changedTask(task, {
            placements: {
              ...task.placements,
              [batchPosition]: {
                logoUrl: uploaded.url,
                logoName: uploaded.originalName,
                ...defaults,
                widthCm: batchWidth,
              },
            },
          })
        : task), true);
      setActivePosition(batchPosition);
      setBatchOpen(false);
      setBatchFile(null);
      setMessage(`已把 ${uploaded.originalName} 应用到 ${eligibleIds.size} 条任务的${PLACEMENT_LABELS[batchPosition]}${failures.length ? `，跳过 ${failures.length} 条缺少底图的任务` : ''}。`);
      if (failures.length) setActionError(failures.join('；'));
    } catch (batchError) {
      setActionError(batchError instanceof Error ? batchError.message : String(batchError));
    } finally {
      setBusy(false);
    }
  };

  if (!state && saveStatus === 'loading') return <main className="loading-screen">正在读取 Demo 任务数据…</main>;

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="workbench-page">
        <header className="workbench-toolbar">
          <div className="batch-summary">
            <strong>简单批量生图 · {state?.tasks.length ?? 0} 个任务</strong>
            <span>{exportedCount} 已导出 · {(state?.tasks.length ?? 0) - exportedCount} 待处理 · {selectedTaskIds.size} 已选</span>
          </div>
          <div className="toolbar-actions">
            {selectedTaskIds.size > 0 && <button className="button danger" type="button" onClick={() => setDeleteTaskIds([...selectedTaskIds])}>删除已选（{selectedTaskIds.size}）</button>}
            <button className="button secondary" disabled={selectedTaskIds.size === 0 || busy} type="button" onClick={() => setBatchOpen(true)}>批量设置</button>
            <select className="button primary export-select" defaultValue="" disabled={busy} aria-label="导出效果图" onChange={(event) => { const value = event.target.value as 'current' | 'selected' | 'all' | ''; event.target.value = ''; if (value) void exportScope(value); }}>
              <option value="">{busy ? '处理中…' : '导出效果图…'}</option>
              <option value="current">导出当前任务</option>
              <option value="selected">导出已选任务</option>
              <option value="all">导出全部任务</option>
            </select>
          </div>
        </header>

        {(error || actionError || defaultsError) && <div className="error-banner workbench-error">{actionError ?? error ?? defaultsError}<button type="button" onClick={() => { setActionError(null); void reload(); }}>重新读取</button></div>}

        <div className="workbench-grid">
          <aside className="task-rail">
            <div className="panel-heading"><strong>制作任务</strong><Link href="/products?mode=append">+ 添加商品任务</Link></div>
            <div className="task-tools">
              <label><input type="checkbox" checked={filteredTasks.length > 0 && filteredTasks.every((task) => selectedTaskIds.has(task.id))} onChange={(event) => setSelectedTaskIds((current) => { const next = new Set(current); for (const task of filteredTasks) { if (event.target.checked) next.add(task.id); else next.delete(task.id); } return next; })} />全选</label>
              <select aria-label="状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | TaskStatus)}><option value="all">全部状态</option><option value="waitingLogo">待上传 Logo</option><option value="ready">可导出</option><option value="exported">已导出</option></select>
            </div>
            <div className="task-list">
              {filteredTasks.map((task) => {
                const product = simpleTaskProduct(task);
                const status = taskStatus(task);
                if (!product) return null;
                return (
                  <article className={`task-row ${task.id === activeTaskId ? 'active' : ''}`} key={task.id}>
                    <input aria-label={`选择任务 ${product.code}`} checked={selectedTaskIds.has(task.id)} type="checkbox" onChange={(event) => setSelectedTaskIds((current) => { const next = new Set(current); if (event.target.checked) next.add(task.id); else next.delete(task.id); return next; })} />
                    <button className="task-main" type="button" onClick={() => setPreferredActiveTaskId(task.id)}>
                      <span className="task-thumb"><Image alt="" fill sizes="40px" src={product.thumbnailUrl} unoptimized={Boolean(task.garment)} /></span>
                      <span><strong>{product.code}</strong><small>{product.name}</small><em data-status={status}>{STATUS_LABELS[status]}</em></span>
                    </button>
                    <button className="more-button" aria-label={`任务 ${product.code} 更多操作`} type="button" onClick={() => setMenuTaskId((current) => current === task.id ? null : task.id)}>···</button>
                    {menuTaskId === task.id && <div className="task-menu"><button type="button" onClick={() => { setDeleteTaskIds([task.id]); setMenuTaskId(null); }}>删除任务</button></div>}
                  </article>
                );
              })}
              {filteredTasks.length === 0 && <div className="empty-state compact">当前筛选下没有任务。</div>}
            </div>
          </aside>

          <section className="canvas-column">
            {activeTask && activeProduct ? (
              <>
                <div className="canvas-heading">
                  <div><strong>{activeProduct.code} · {activeProduct.name}</strong><Link href={`/products?mode=replace&taskId=${encodeURIComponent(activeTask.id)}`}>更换商品</Link><span>任务 {activeTask.id.slice(0, 8)} · {Object.keys(activeTask.placements).map((key) => PLACEMENT_LABELS[key as PlacementKey]).join(' + ') || '尚未设置制作位置'}</span></div>
                  <div><strong>{STATUS_LABELS[taskStatus(activeTask)]}</strong><span>{saveStatus === 'saving' ? '正在保存…' : saveStatus === 'saved' ? '已自动保存' : '保存异常'}</span></div>
                </div>
                <MockupCanvas onResizePosition={(key, widthCm) => updatePlacement(activeTask.id, key, placement => ({ ...placement, widthCm }))} activePosition={activePosition} onMovePosition={(key, offsetX, offsetY) => updatePlacement(activeTask.id, key, (placement) => ({ ...placement, offsetX, offsetY }))} onSelectPosition={setActivePosition} product={activeProduct} task={activeTask} />
                <div className="canvas-message"><span>{message}</span>{lastDeleted.length > 0 && <button type="button" onClick={() => void undoDelete()}>撤销删除</button>}</div>
              </>
            ) : (
              <div className="empty-workbench"><span className="empty-icon">衣</span><h1>当前批次还没有任务</h1><p>先从商品素材库选择一款或多款衣服。</p><Link className="button primary" href="/products?mode=append">前往商品素材库</Link></div>
            )}
          </section>

          <aside className="settings-panel">
            <div className="panel-heading"><strong>当前任务设置</strong><Link href="/logo-studio">智能处理 Logo</Link></div>
            {activeTask ? (
              <div className="settings-body">
                <section className="setting-section">
                  <h2>1. Logo 与制作位置</h2><p>{activeTask.garment ? '优先使用素材库已校准位置，其余使用默认位置，可直接上传并调整。' : '这是保留的旧版任务。更换为素材库衣服后，自动带入默认位置。'}</p>
                  <div>{activeTask.garment && <button className="button secondary full" disabled={busy} type="button" onClick={() => void refreshStandards()}>更新位置标准</button>}</div>
                  <div className="placement-list">
                    {PLACEMENT_KEYS.map((key) => {
                      const placement = activeTask.placements[key];
                      const positionIssue = simplePositionIssue(activeTask, key, placement);
                      return (
                        <div className={`placement-row ${activePosition === key ? 'active' : ''}`} key={key}>
                          <button className="placement-main" type="button" onClick={() => setActivePosition(key)}><strong>{PLACEMENT_LABELS[key]}</strong><span>{positionIssue ? '缺少底图' : placement ? `${placement.logoName} · ${placement.widthCm}cm` : activeTask.garment ? `${simplePositionSource(activeTask, key, placement)} · 未上传 Logo` : '未设置 Logo'}</span></button>
                          <button disabled={Boolean(positionIssue) || busy} title={positionIssue ?? undefined} type="button" onClick={() => requestLogoUpload(key)}>{placement ? '更换' : '上传'}</button>
                          <button disabled={!placement} type="button" onClick={() => void clearPlacement(key)}>清除</button>
                        </div>
                      );
                    })}
                  </div>
                  <input ref={logoInputRef} hidden accept="image/png,image/jpeg,image/webp" type="file" onChange={(event) => void logoSelected(event.target.files?.[0] ?? null)} />
                </section>
                <section className="setting-section adjust-section">
                  <h2>2. 调整当前位置：{PLACEMENT_LABELS[activePosition]}</h2>
                  {activeTask.garment && <><p>尺寸沿用生产台的 55cm 衣身效果图比例。</p>{simplePositionIssue(activeTask, activePosition, activePlacement) && <p role="alert">{simplePositionIssue(activeTask, activePosition, activePlacement)} <Link href="/products">查看素材库</Link></p>}</>}
                  {activeTask.garment && activePosition === 'back' && simpleBackPositions(activeTask).length > 0 && <label className="range-control">后背位置<select aria-label="后背位置" disabled={!activePlacement} value={activePlacement?.catalogPosition ?? (simpleBackPositions(activeTask).includes('backCenter') ? 'backCenter' : 'upperBack')} onChange={event => updatePlacement(activeTask.id, 'back', placement => ({ ...placement, catalogPosition: event.target.value as 'upperBack' | 'backCenter', offsetX: 0, offsetY: 0 }))}>{simpleBackPositions(activeTask).map(key => <option key={key} value={key}>{POSITION_LABELS[key]}</option>)}</select></label>}
                  {activePlacement && <button className="button secondary full" type="button" onClick={() => updatePlacement(activeTask.id, activePosition, placement => ({ ...placement, offsetX: 0, offsetY: 0, rotation: 0 }))}>恢复默认位置</button>}
                  <LogoWidthControl key={`${activeTask.id}:${activePosition}`} disabled={!activePlacement} value={activePlacement?.widthCm ?? PLACEMENT_DEFAULTS[activePosition].widthCm} onChange={widthCm => updatePlacement(activeTask.id, activePosition, placement => ({ ...placement, widthCm }))} />
                  <RangeControl disabled={!activePlacement} label="左右位置" max={35} min={-35} step={0.5} value={activePlacement?.offsetX ?? 0} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, offsetX: value }))} />
                  <RangeControl disabled={!activePlacement} label="上下位置" max={35} min={-35} step={0.5} value={activePlacement?.offsetY ?? 0} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, offsetY: value }))} />
                  <RangeControl disabled={!activePlacement} label="旋转角度" max={180} min={-180} step={1} suffix="°" value={activePlacement?.rotation ?? 0} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, rotation: value }))} />
                  <button className="button secondary full" disabled={!activePlacement || busy} type="button" onClick={() => void cutoutActiveLogo()}>{busy ? '处理中…' : '去除当前 Logo 白底'}</button>
                </section>
                {activePlacement && (
                  <LogoTextVerification
                    key={`${activeTask.id}:${activePosition}:${activePlacement.logoUrl}`}
                    logoName={activePlacement.logoName}
                    logoUrl={activePlacement.logoUrl}
                  />
                )}
              </div>
            ) : <div className="empty-state compact">选择任务后显示设置。</div>}
          </aside>
        </div>
      </main>

      {deleteTaskIds.length > 0 && (
        <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">删除制作任务</h2><p>确定删除 {deleteTaskIds.length} 条任务吗？其中的 Logo 设置和已导出记录也会一起移除。</p><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setDeleteTaskIds([])}>取消</button><button className="button danger" type="button" onClick={() => void confirmDelete()}>确认删除</button></div></section></div>
      )}

      {batchOpen && (
        <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="batch-title"><h2 id="batch-title">批量应用 Logo 设置</h2><p>把同一张 Logo 应用到已勾选的 {selectedTaskIds.size} 条任务，之后仍可逐条调整。</p><div className="modal-grid"><label className="wide">Logo 文件<input accept="image/png,image/jpeg,image/webp" type="file" onChange={(event) => setBatchFile(event.target.files?.[0] ?? null)} /></label><label>制作位置<select value={batchPosition} onChange={(event) => { const position = event.target.value as PlacementKey; setBatchPosition(position); setBatchWidth(PLACEMENT_DEFAULTS[position].widthCm); }}>{PLACEMENT_KEYS.map((key) => <option key={key} value={key}>{PLACEMENT_LABELS[key]}</option>)}</select></label>{batchPosition === 'back' && <label>后背位置<select value={batchBackPosition} onChange={event => setBatchBackPosition(event.target.value as 'upperBack' | 'backCenter')}><option value="backCenter">后背居中</option><option value="upperBack">后背上方</option></select></label>}<label>宽度（cm）<input max={100} min={0.5} step={0.1} type="number" value={batchWidth} onChange={(event) => setBatchWidth(Number(event.target.value))} /></label></div><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setBatchOpen(false)}>取消</button><button className="button primary" disabled={!batchFile || busy} type="button" onClick={() => void applyBatch()}>{busy ? '正在应用…' : `应用到 ${selectedTaskIds.size} 条任务`}</button></div></section></div>
      )}
    </div>
  );
}

type RangeControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled: boolean;
  onChange: (value: number) => void;
};

function RangeControl({ label, value, min, max, step, suffix = '', disabled, onChange }: RangeControlProps) {
  return (
    <label className="range-control"><span>{label}<strong>{Number.isInteger(value) ? value : Number(value.toFixed(2))}{suffix}</strong></span><input disabled={disabled} max={max} min={min} step={step} type="range" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
  );
}

function LogoWidthControl({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (width: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <div className="simple-logo-size-control">
    <label>Logo 宽度<span><input aria-label="Logo 宽度数值（cm）" type="number" min={0.5} max={100} step={0.1} disabled={disabled} value={draft ?? Number(value.toFixed(2))}
      onChange={event => { const raw = event.target.value; setDraft(raw); const width = Number(raw); if (raw && Number.isFinite(width) && width >= .5 && width <= 100) onChange(width); }}
      onBlur={() => { if (draft && Number.isFinite(Number(draft))) onChange(Math.max(.5, Math.min(100, Number(draft)))); setDraft(null); }} /> cm</span></label>
    <input aria-label="Logo 宽度滑块" type="range" min={0.5} max={100} step={0.1} disabled={disabled} value={value} onChange={event => { setDraft(null); onChange(Number(event.target.value)); }} />
    <small>也可拖动 Logo 四角等比缩放。</small>
  </div>;
}
