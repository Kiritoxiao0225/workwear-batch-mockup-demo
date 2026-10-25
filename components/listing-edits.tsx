"use client";
/* eslint-disable @next/next/no-img-element -- images come from the listing API */
/**
 * 电商主图「改图进度」(10-25): every 「按要求修改」 of a product that still waits for the user (being
 * made, a new image to adopt, or a failure) listed in one place above the images, and the same state
 * as a tag on each image. It is the server's state, so closing the dialog or the page loses nothing.
 */
import { useEffect, useState } from "react";
import type { Redraw } from "@/lib/listing/api-types";

const two = (n: number) => String(n).padStart(2, "0");
const hm = (iso: string) => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const span = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

export const editActive = (r?: Redraw) => r?.status === "queued" || r?.status === "running";

/** A clock that ticks every second while `on`, for the waits shown. */
export function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [on]);
  return now;
}

export type EditTone = "b" | "g" | "r";
/** The tag on the image. */
export function editTag(r: Redraw): { tone: EditTone; tag: string } {
  if (r.status === "queued") return { tone: "b", tag: r.retries ? "等待重试" : "排队中" };
  if (r.status === "running") return { tone: "b", tag: "改图中" };
  return r.status === "succeeded" ? { tone: "g", tag: "新图待采用" } : { tone: "r", tag: "改图失败" };
}
/** What a redraw is doing, in full: for the list and the dialog. */
export function editText(r: Redraw, now: number) {
  const at = r.at ? ` · ${hm(r.at)} 提交` : "";
  if (r.status === "queued") return r.retries
    ? `上次没出来（${r.error ?? "出图通道出错"}），会自动再试，不扣费${r.retryAt ? `，约 ${span(Date.parse(r.retryAt) - now)}后` : ""}${at}`
    : `排队中${r.ahead ? `，前面还有 ${r.ahead} 张` : ""}${at}`;
  if (r.status === "running") return `正在改${r.at ? `，已等 ${span(now - Date.parse(r.at))}` : ""}，一般 1 分钟左右${at}`;
  if (r.status === "succeeded") return `新图好了${r.done ? `（${hm(r.done)}）` : ""}，满意就采用，不满意可以接着改`;
  return `没改成：${r.error || "出图失败"}。没扣积分${at}`;
}
/** 「2 张改图中 · 1 张待采用 · 1 张失败」 */
export const editsSummary = (e: { running: number; ready: number; failed: number }) =>
  [e.running && `${e.running} 张改图中`, e.ready && `${e.ready} 张待采用`, e.failed && `${e.failed} 张没改成`].filter(Boolean).join(" · ");

export type EditItem = { slot: string; label: string; image: string; redraw: Redraw };

export function EditsBar({ items, busy, onLocate, onOpen, onAdopt, onKeep }: {
  items: EditItem[]; busy: boolean;
  onLocate: (slot: string) => void; onOpen: (slot: string) => void; onAdopt: (item: EditItem) => void; onKeep: (item: EditItem) => void;
}) {
  const now = useNow(items.some(i => editActive(i.redraw)));
  if (!items.length) return null;
  const count = (f: (r: Redraw) => boolean) => items.filter(i => f(i.redraw)).length;
  return (
    <section className="lp-edits" aria-label="改图进度">
      <div className="lp-edits-head"><b>改图进度</b>
        <span>{editsSummary({ running: count(editActive), ready: count(r => r.status === "succeeded"), failed: count(r => r.status === "failed") })}</span>
        <small>关掉窗口也会在后台接着改；可以一次给好几张图提要求</small></div>
      <ul>{items.map(i => {
        const t = editTag(i.redraw), r = i.redraw;
        return (
          <li key={i.slot} className={t.tone}>
            <button type="button" className="th" title="在下面找到这张" onClick={() => onLocate(i.slot)}><img src={i.image} alt="" /></button>
            <div className="tx">
              <b>{i.label}</b>
              {r.ask && <span className="ask" title={r.ask}>「{r.ask}」</span>}
              <span className="st"><i className="dot" />{editText(r, now)}</span>
            </div>
            <div className="go">
              {editActive(r) && <button type="button" className="lp-btn sm" onClick={() => onLocate(i.slot)}>找到这张</button>}
              {r.status === "succeeded" && <>
                <button type="button" className="lp-btn sm primary" disabled={busy} onClick={() => onAdopt(i)}>采用</button>
                <button type="button" className="lp-btn sm" onClick={() => onOpen(i.slot)}>对比 / 接着改</button>
                <button type="button" className="lp-btn sm ghost" disabled={busy} title="新图留在历史里，还能换回" onClick={() => onKeep(i)}>不用</button></>}
              {r.status === "failed" && <>
                <button type="button" className="lp-btn sm" onClick={() => onOpen(i.slot)}>重新改</button>
                <button type="button" className="lp-btn sm ghost" disabled={busy} onClick={() => onKeep(i)}>知道了</button></>}
            </div>
          </li>);
      })}</ul>
    </section>
  );
}
