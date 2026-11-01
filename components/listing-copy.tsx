"use client";
/* eslint-disable @next/next/no-img-element -- layout samples are our own static images */
/**
 * 「用这份素材再出一套」: pick one or more masters; each becomes a product of its own from the same
 * material, at 「定方案」 or started at once on its default plan. No upload and no analysis again;
 * the white images and the cast are carried over (listing-copy). 11-01: who is on the new covers and
 * whether an 一体 jacket is worn open are picked here too, as on the plan's step ②.
 */
import { useState } from "react";
import type { LayoutCard } from "@/lib/listing/api-types";
import type { Draft } from "@/lib/listing/draft";
import { COVER_PEOPLE, type CoverPeople } from "@/lib/listing/templates";

/** The new sets' covers: `people` none is each master's own; `open` none is as the first product. */
export type CopyCover = { people?: CoverPeople; open?: boolean };
const PEOPLE_NAME: Record<CoverPeople, string> = { 女: "单人 · 女生", 男: "单人 · 男生", 男女: "一男一女" };

export const MAX_COPIES = 5;

export function CopyDialog({ name, current, wear, layouts, onCopy, onClose }: {
  name: string; current: string; layouts: LayoutCard[];
  /** How the first product is worn: an 一体 jacket gets the open-or-zipped choice, starting where it was. */
  wear?: Draft["wear"];
  onCopy: (layouts: string[], direct: boolean, cover: CopyCover) => Promise<void>; onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [people, setPeople] = useState<CoverPeople | undefined>(undefined);
  const oneBody = wear?.type === "一体";
  const [open, setOpen] = useState(!!wear?.open);
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
          <div className="lp-copy-cover">
            <div className="lp-chips"><span className="lp-muted lp-small">首图人物</span>
              <button type="button" className={"lp-chip" + (!people ? " on" : "")} onClick={() => setPeople(undefined)}>按各母版默认</button>
              {COVER_PEOPLE.map(p => <button type="button" key={p} className={"lp-chip" + (people === p ? " on" : "")} onClick={() => setPeople(p)}>{PEOPLE_NAME[p]}</button>)}</div>
            {oneBody && <div className="lp-chips"><span className="lp-muted lp-small">首图穿法</span>
              <button type="button" className={"lp-chip" + (open ? " on" : "")} onClick={() => setOpen(true)}>敞开，露出里面</button>
              <button type="button" className={"lp-chip" + (!open ? " on" : "")} onClick={() => setOpen(false)}>拉链拉到顶</button></div>}
            <p className="lp-muted lp-small">只管首图（产品静物那套没有人，不受影响）；其它图照母版自己的人数。{oneBody && "敞开时照这款选好的里面照片画。"}</p>
          </div>
        </div>
        <div className="lp-box-foot">
          <label className="grow lp-small"><input type="checkbox" checked={direct} onChange={e => setDirect(e.target.checked)} /> 按默认方案直接出图（不进方案页；有红色问题的那套留在「定方案」等你处理）。出图照常按张计费</label>
          <button type="button" className="lp-btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="lp-btn primary" disabled={busy || !picked.length}
            onClick={() => { setBusy(true); void onCopy(picked, direct, { ...(people ? { people } : {}), ...(oneBody ? { open } : {}) }).finally(() => setBusy(false)); }}>
            {busy ? "正在建…" : picked.length ? `再出 ${picked.length} 套` : "选一个或几个版式"}</button>
        </div>
      </div>
    </div>
  );
}
