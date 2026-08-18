'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useMemo, useRef, useState } from 'react';

import { AppHeader } from '@/components/app-header';
import { MockupCanvas } from '@/components/mockup-canvas';
import { useDemoState } from '@/hooks/use-demo-state';
import { exportTasks } from '@/lib/client/export';
import { removeWhiteBackground, uploadLogo } from '@/lib/client/logo';
import {
  PLACEMENT_DEFAULTS,
  PLACEMENT_LABELS,
  taskStatus,
} from '@/lib/mockup';
import { productByCode } from '@/lib/products';
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
  const { state, saveStatus, error, reload, updateState } = useDemoState();
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
  const activeProduct = activeTask ? productByCode(activeTask.productCode) : null;
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
    tasks: transform(current.tasks),
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
      await updateTask(activeTask.id, (task) => changedTask(task, {
        placements: {
          ...task.placements,
          [pendingUploadPosition]: {
            logoUrl: uploaded.url,
            logoName: uploaded.originalName,
            ...defaults,
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
      setMessage(`${PLACEMENT_LABELS[activePosition]} Logo 已去除近白色背景。`);
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
      setMessage(`已导出 ${result.exportedTaskIds.length} 条任务${result.skipped ? `，跳过 ${result.skipped} 条未上传 Logo 的任务` : ''}。`);
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
      const uploaded = await uploadLogo(batchFile);
      const defaults = PLACEMENT_DEFAULTS[batchPosition];
      await saveTasks((tasks) => tasks.map((task) => selectedTaskIds.has(task.id)
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
      setMessage(`已把 ${uploaded.originalName} 应用到 ${selectedTaskIds.size} 条任务的${PLACEMENT_LABELS[batchPosition]}。`);
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
            <strong>本批次 {state?.tasks.length ?? 0} 个任务</strong>
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

        {(error || actionError) && <div className="error-banner workbench-error">{actionError ?? error}<button type="button" onClick={() => { setActionError(null); void reload(); }}>重新读取</button></div>}

        <div className="workbench-grid">
          <aside className="task-rail">
            <div className="panel-heading"><strong>制作任务</strong><Link href="/products">+ 添加商品任务</Link></div>
            <div className="task-tools">
              <label><input type="checkbox" checked={filteredTasks.length > 0 && filteredTasks.every((task) => selectedTaskIds.has(task.id))} onChange={(event) => setSelectedTaskIds((current) => { const next = new Set(current); for (const task of filteredTasks) { if (event.target.checked) next.add(task.id); else next.delete(task.id); } return next; })} />全选</label>
              <select aria-label="状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | TaskStatus)}><option value="all">全部状态</option><option value="waitingLogo">待上传 Logo</option><option value="ready">可导出</option><option value="exported">已导出</option></select>
            </div>
            <div className="task-list">
              {filteredTasks.map((task) => {
                const product = productByCode(task.productCode);
                const status = taskStatus(task);
                if (!product) return null;
                return (
                  <article className={`task-row ${task.id === activeTaskId ? 'active' : ''}`} key={task.id}>
                    <input aria-label={`选择任务 ${product.code}`} checked={selectedTaskIds.has(task.id)} type="checkbox" onChange={(event) => setSelectedTaskIds((current) => { const next = new Set(current); if (event.target.checked) next.add(task.id); else next.delete(task.id); return next; })} />
                    <button className="task-main" type="button" onClick={() => setPreferredActiveTaskId(task.id)}>
                      <span className="task-thumb"><Image alt="" fill sizes="40px" src={product.thumbnailUrl} /></span>
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
                <MockupCanvas activePosition={activePosition} onMovePosition={(key, offsetX, offsetY) => updatePlacement(activeTask.id, key, (placement) => ({ ...placement, offsetX, offsetY }))} onSelectPosition={setActivePosition} product={activeProduct} task={activeTask} />
                <div className="canvas-message"><span>{message}</span>{lastDeleted.length > 0 && <button type="button" onClick={() => void undoDelete()}>撤销删除</button>}</div>
              </>
            ) : (
              <div className="empty-workbench"><span className="empty-icon">衣</span><h1>当前批次还没有任务</h1><p>先从商品素材库选择一款或多款衣服。</p><Link className="button primary" href="/products">前往商品素材库</Link></div>
            )}
          </section>

          <aside className="settings-panel">
            <div className="panel-heading"><strong>当前任务设置</strong><span>只保存到当前任务</span></div>
            {activeTask ? (
              <div className="settings-body">
                <section className="setting-section">
                  <h2>1. Logo 与制作位置</h2><p>每个位置单独上传，多个 Logo 不会混淆。</p>
                  <div className="placement-list">
                    {PLACEMENT_KEYS.map((key) => {
                      const placement = activeTask.placements[key];
                      return (
                        <div className={`placement-row ${activePosition === key ? 'active' : ''}`} key={key}>
                          <button className="placement-main" type="button" onClick={() => setActivePosition(key)}><strong>{PLACEMENT_LABELS[key]}</strong><span>{placement ? `${placement.logoName} · ${placement.widthCm}cm` : '未设置 Logo'}</span></button>
                          <button type="button" onClick={() => requestLogoUpload(key)}>{placement ? '更换' : '上传'}</button>
                          <button disabled={!placement} type="button" onClick={() => void clearPlacement(key)}>清除</button>
                        </div>
                      );
                    })}
                  </div>
                  <input ref={logoInputRef} hidden accept="image/png,image/jpeg,image/webp" type="file" onChange={(event) => void logoSelected(event.target.files?.[0] ?? null)} />
                </section>
                <section className="setting-section adjust-section">
                  <h2>2. 调整当前位置：{PLACEMENT_LABELS[activePosition]}</h2>
                  <RangeControl disabled={!activePlacement} label="Logo 宽度" max={40} min={2} step={0.5} suffix="cm" value={activePlacement?.widthCm ?? PLACEMENT_DEFAULTS[activePosition].widthCm} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, widthCm: value }))} />
                  <RangeControl disabled={!activePlacement} label="左右位置" max={35} min={-35} step={0.5} value={activePlacement?.offsetX ?? 0} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, offsetX: value }))} />
                  <RangeControl disabled={!activePlacement} label="上下位置" max={35} min={-35} step={0.5} value={activePlacement?.offsetY ?? 0} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, offsetY: value }))} />
                  <RangeControl disabled={!activePlacement} label="旋转角度" max={180} min={-180} step={1} suffix="°" value={activePlacement?.rotation ?? 0} onChange={(value) => updatePlacement(activeTask.id, activePosition, (placement) => ({ ...placement, rotation: value }))} />
                  <button className="button secondary full" disabled={!activePlacement || busy} type="button" onClick={() => void cutoutActiveLogo()}>{busy ? '处理中…' : '去除当前 Logo 白底'}</button>
                </section>
              </div>
            ) : <div className="empty-state compact">选择任务后显示设置。</div>}
          </aside>
        </div>
      </main>

      {deleteTaskIds.length > 0 && (
        <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><h2 id="delete-title">删除制作任务</h2><p>确定删除 {deleteTaskIds.length} 条任务吗？其中的 Logo 设置和已导出记录也会一起移除。</p><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setDeleteTaskIds([])}>取消</button><button className="button danger" type="button" onClick={() => void confirmDelete()}>确认删除</button></div></section></div>
      )}

      {batchOpen && (
        <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="batch-title"><h2 id="batch-title">批量应用 Logo 设置</h2><p>把同一张 Logo 应用到已勾选的 {selectedTaskIds.size} 条任务，之后仍可逐条调整。</p><div className="modal-grid"><label className="wide">Logo 文件<input accept="image/png,image/jpeg,image/webp" type="file" onChange={(event) => setBatchFile(event.target.files?.[0] ?? null)} /></label><label>制作位置<select value={batchPosition} onChange={(event) => { const position = event.target.value as PlacementKey; setBatchPosition(position); setBatchWidth(PLACEMENT_DEFAULTS[position].widthCm); }}>{PLACEMENT_KEYS.map((key) => <option key={key} value={key}>{PLACEMENT_LABELS[key]}</option>)}</select></label><label>宽度（cm）<input max={40} min={2} step={0.5} type="number" value={batchWidth} onChange={(event) => setBatchWidth(Number(event.target.value))} /></label></div><div className="modal-actions"><button className="button secondary" type="button" onClick={() => setBatchOpen(false)}>取消</button><button className="button primary" disabled={!batchFile || busy} type="button" onClick={() => void applyBatch()}>{busy ? '正在应用…' : `应用到 ${selectedTaskIds.size} 条任务`}</button></div></section></div>
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
    <label className="range-control"><span>{label}<strong>{value}{suffix}</strong></span><input disabled={disabled} max={max} min={min} step={step} type="range" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>
  );
}
