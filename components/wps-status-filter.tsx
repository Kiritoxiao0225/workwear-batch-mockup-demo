'use client';

import { useEffect, useRef } from 'react';

export const DEFAULT_WPS_STATUSES = ['🔴待领取'];

export function WpsStatusFilter({ counts, selected, change }: {
  counts: Map<string, number>; selected: string[] | null; change: (statuses: string[] | null) => void;
}) {
  const dropdown = useRef<HTMLDetailsElement>(null);
  const options = new Map(counts);
  for (const status of selected ?? []) if (!options.has(status)) options.set(status, 0);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (dropdown.current && !dropdown.current.contains(event.target as Node)) dropdown.current.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);
  return <details ref={dropdown} className="wps-status-multiselect" onKeyDown={event => {
    if (event.key === 'Escape' && dropdown.current?.open) {
      dropdown.current.open = false;
      dropdown.current.querySelector('summary')?.focus();
    }
  }}>
    <summary aria-label="WPS 任务状态（多选）"><span>{selected === null ? '全部状态' : selected.length ? selected.join('、') : '请选择状态'}</span><small>多选</small></summary>
    <div className="wps-status-options" role="group" aria-label="选择 WPS 任务状态">
      <p>可多选，勾选后立即生效</p>
      <div className="wps-status-shortcuts"><button type="button" onClick={() => change(null)}>全选</button><button type="button" onClick={() => change([])}>清空</button><button type="button" onClick={() => change([...DEFAULT_WPS_STATUSES])}>恢复默认</button></div>
      {[...options].map(([status, count]) => <label key={status}>
        <input type="checkbox" checked={selected === null || selected.includes(status)} onChange={event => {
          const current = selected ?? [...options.keys()];
          change(event.target.checked ? [...current, status] : current.filter(value => value !== status));
        }} />
        <span>{status}</span><small>{count}</small>
      </label>)}
    </div>
  </details>;
}
