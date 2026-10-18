"use client";
/* eslint-disable @next/next/no-img-element -- layout samples are our own static images */
/**
 * 「用这份素材再出一套」: pick one or more masters; each becomes a product of its own from the same
 * material, at 「定方案」 or started at once on its default plan. No upload and no analysis again;
 * the white images and the cast are carried over (listing-copy).
 */
import { useState } from "react";
import type { LayoutCard } from "@/lib/listing/api-types";

export const MAX_COPIES = 5;

export function CopyDialog({ name, current, layouts, onCopy, onClose }: {
  name: string; current: string; layouts: LayoutCard[];
  onCopy: (layouts: string[], direct: boolean) => Promise<void>; onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [direct, setDirect] = useState(true);
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : p.length < MAX_COPIES ? [...p, id] : p);
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="用这份素材再出一套">
        <div className="lp-box-head"><div><h3>用这份素材再出一套 · {name}</h3>
          <p className="lp-sub">不用重新上传，也不再收整理费；每个颜色的白底图和模特定妆照直接沿用。选几个版式就多出几款商品，首图主打的卖点和画面会自动换着来。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" disabled={busy} onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <div className="lp-layouts">{layouts.map(l => (
            <button type="button" key={l.id} className={"lp-layout" + (picked.includes(l.id) ? " on" : "")} aria-pressed={picked.includes(l.id)} onClick={() => toggle(l.id)}>
              <span className="ok">✓</span>
              {l.id === current && <span className="lp-tag">这款现在用的</span>}
              <span className="pics">{l.samples.slice(0, 3).map(src => <img key={src} src={src} alt="" loading="lazy" />)}</span>
              <b>{l.name}</b>{l.description && <p>{l.description}</p>}
            </button>))}</div>
        </div>
        <div className="lp-box-foot">
          <label className="grow lp-small"><input type="checkbox" checked={direct} onChange={e => setDirect(e.target.checked)} /> 按默认方案直接出图（不进方案页；有红色问题的那套留在「定方案」等你处理）。出图照常按张计费</label>
          <button type="button" className="lp-btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="lp-btn primary" disabled={busy || !picked.length}
            onClick={() => { setBusy(true); void onCopy(picked, direct).finally(() => setBusy(false)); }}>
            {busy ? "正在建…" : picked.length ? `再出 ${picked.length} 套` : "选一个或几个版式"}</button>
        </div>
      </div>
    </div>
  );
}
