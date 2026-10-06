"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图 results: the main set, each extra colour's covers, the SKU and product images. Any image
 * opens 「改这一张」: another selling point, other words or colours, an extra request; only that
 * image is remade and the earlier versions stay.
 */
import { useState } from "react";
import type { LayoutCard, Materials } from "./listing-plan";

type Words = { title: string; subtitle: string; bullets: string[]; scene?: string };
export type SlotState = { slot: string; status: string; error: string | null; image: string | null; versions: number; history: { id: string; words: Words | null }[]; words: Words | null;
  input: { kind: string; skus?: string[]; slot?: { role: string; title: string; colors: string[] } } };
export type StoredPlan = { colors: { name: string; hex: string; sku: string }[]; extra: { color: string; layout: string }[] };
export type ResultDetail = { id: string; name: string; status: string; plan: StoredPlan | null; materials: Materials | null; slots: SlotState[] };

const MAIN = /^(square|portrait|poster):/;
const SHAPE: Record<string, string> = { square: "1 / 1", portrait: "3 / 4", poster: "2 / 3", sku: "1 / 1", product: "1 / 1" };
const KIND_LABEL: Record<string, string> = { square: "1:1 主图", portrait: "3:4 主图", poster: "2:3 海报", sku: "SKU 图", product: "白底产品图" };
const post = async (path: string, body: unknown) => {
  const response = await fetch("/api/listing/" + path, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
};
const numOf = (slot: string) => slot.startsWith("poster") ? "海报" : `第 ${slot.split(":")[1].split("+")[0]} 张`;

export function ResultsPanel({ detail, layouts, exempt, imageCredits, onEdit, onRedo, onDone, onError, onClose }: {
  detail: ResultDetail; layouts: LayoutCard[]; exempt: boolean; imageCredits: number;
  onEdit: (slot: SlotState) => void; onRedo: (slot: string, label: string) => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void; onClose: () => void;
}) {
  const colors = detail.plan?.colors ?? [], main = colors[0];
  const nameOf = (sku: string) => colors.find(c => c.sku === sku)?.name ?? sku;
  const free = colors.filter(c => c !== main && !detail.plan?.extra.some(e => e.color === c.name));
  const [adding, setAdding] = useState<{ color: string; layout: string } | null>(null);
  const generating = detail.status === "generating";
  const made = detail.slots.filter(s => s.image).length;
  // 1:1 before 3:4 before the poster, then by number.
  const order = (slot: string) => `${["square", "portrait", "poster", "sku", "product"].indexOf(slot.split(":")[0])}${slot.replace(/\d+/, n => n.padStart(2, "0"))}`;
  const tile = (s: SlotState) => {
    const [kind, key] = s.slot.split(":"), busy = s.status === "queued" || s.status === "running", bad = !s.image && !busy;
    const label = kind === "sku" || kind === "product" ? nameOf(key) : `${numOf(s.slot)} · ${s.words?.title || s.input.slot?.title || ""}`;
    const version = s.history.findIndex(v => v.id === s.image) + 1, main = MAIN.test(s.slot) && s.history.length > 0;
    return (
      <div key={s.slot} className={"lp-out" + (bad ? " bad" : "")}>
        <div className="lp-out-img" style={{ aspectRatio: SHAPE[kind] }}>
          {s.image && (main && !busy
            ? <button type="button" className="lp-out-open" title="点图修改这一张" onClick={() => onEdit(s)}><img src={`/api/listing/assets/${s.image}`} alt={label} loading="lazy" /></button>
            : <a href={`/api/listing/assets/${s.image}`} target="_blank" rel="noreferrer"><img src={`/api/listing/assets/${s.image}`} alt={label} loading="lazy" /></a>)}
          {s.versions > 1 && version > 0 && <span className="lp-out-ver">第 {version} 版</span>}
          {busy && <span className="lp-out-wait">{s.status === "running" ? "出图中…" : "排队中"}</span>}
          {bad && <span className="lp-out-wait">没做出来</span>}
        </div>
        <b title={label}>{label}</b>
        {bad && s.error && <small className="lp-out-why">{s.error}</small>}
        {!busy && (main ? <button type="button" className="lp-btn sm" onClick={() => onEdit(s)}>改这张</button>
          : <button type="button" className="lp-btn sm" onClick={() => onRedo(s.slot, label)}>重做</button>)}
      </div>);
  };
  const lane = (title: string, pick: (s: SlotState) => boolean, note = "") => {
    const items = detail.slots.filter(pick).sort((a, b) => order(a.slot).localeCompare(order(b.slot)));
    return items.length ? <div className="lp-lane" key={title}><div className="lp-lane-label">{title}{note && <span className="lp-keep">{note}</span>}</div><div className="lp-tiles">{items.map(tile)}</div></div> : null;
  };
  const sets = [...new Set(detail.slots.map(s => s.slot.split("+")[1]).filter(Boolean))];
  const addSet = async () => {
    try { await post(`projects/${detail.id}/sets`, adding); setAdding(null); await onDone(`「${adding!.color}」的首图开始出了`); } catch (error) { onError((error as Error).message); }
  };
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan" role="dialog" aria-modal="true" aria-label="出好的图">
        <div className="lp-box-head"><div><h3>{generating ? "出图中" : "出好的图"} · {detail.name}</h3>
          <p className="lp-sub">{generating ? `做好 ${made}/${detail.slots.length} 张，关掉也会继续。` : "点任意一张主图就能改：换卖点、换颜色、改字，只重画这一张。"}</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          {(["square", "portrait", "poster"] as const).map(kind => lane(`${main ? `主推套 · ${main.name} · ` : ""}${KIND_LABEL[kind]}`, s => s.slot.startsWith(kind + ":") && !s.slot.includes("+"), kind === "portrait" ? "讲的和 1:1 一样，换了排版" : ""))}
          {sets.map(sku => lane(`加的一套 · ${nameOf(sku)}`, s => s.slot.endsWith("+" + sku), "只换了首图，其余图和主推套共用"))}
          {lane("SKU 图", s => s.slot.startsWith("sku:"))}
          {lane("白底产品图", s => s.slot.startsWith("product:"))}
        </div>
        <div className="lp-box-foot">
          {adding ? <>
            <div className="grow">再加一套首图：颜色 <select value={adding.color} onChange={e => setAdding({ ...adding, color: e.target.value })}>{free.map(c => <option key={c.sku}>{c.name}</option>)}</select>
              {" "}版式 <select value={adding.layout} onChange={e => setAdding({ ...adding, layout: e.target.value })}><option value="">跟主推套一样</option>{layouts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              {" "}1:1 首图 + 3:4 首图 + 海报{exempt ? "" : `，每张 ${imageCredits} 积分`}</div>
            <button type="button" className="lp-btn" onClick={() => setAdding(null)}>取消</button>
            <button type="button" className="lp-btn primary" onClick={() => void addSet()}>开始出这一套</button>
          </> : <>
            <div className="grow" />
            {free.length > 0 && !generating && <button type="button" className="lp-btn" onClick={() => setAdding({ color: free[0].name, layout: "" })}>＋ 再加一套首图（换颜色）</button>}
            {made > 0 && <a className="lp-btn primary" href={`/api/listing/projects/${detail.id}/download`}>全部下载</a>}
          </>}
        </div>
      </div>
    </div>
  );
}

/** One main image's content as the user edits it; labels follow the page wording (小字 = subtitle, 标签 = bullets). */
type Draft = { title: string; subtitle: string; tags: string; scene: string };
const toDraft = (w: Partial<Words> | null | undefined): Draft => ({ title: w?.title ?? "", subtitle: w?.subtitle ?? "", tags: (w?.bullets ?? []).join("、"), scene: w?.scene ?? "" });
const toWords = (d: Draft): Words => ({ title: d.title.trim(), subtitle: d.subtitle.trim(), bullets: d.tags.split(/[、,，;；]/).map(t => t.trim()).filter(Boolean).slice(0, 3), scene: d.scene.trim() });
const FIELDS: [keyof Draft, string, number, string][] = [
  ["title", "大标题", 20, "必填"], ["subtitle", "小字", 30, "可空"], ["tags", "标签", 52, "图上的小标签，用顿号隔开，最多 3 个"], ["scene", "画面", 400, "画面里拍什么、怎么演示卖点"],
];

/**
 * Change one finished main image. What the user changed decides how it is remade: only the words
 * keep the picture (the image being looked at is the reference); a new picture, other colours or
 * an extra request redraw it. Earlier versions stay and can be chosen again.
 */
export function EditDialog({ detail, slot, prices, exempt, onClose, onDone, onError }: { detail: ResultDetail; slot: SlotState; prices: { image: number; multi: number }; exempt: boolean; onClose: () => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const kind = slot.slot.split(":")[0];
  const [viewing, setViewing] = useState(slot.image ?? slot.history.at(-1)?.id ?? "");
  // The form shows the words of the version being looked at; that is what "只改字" edits.
  const base = toDraft(slot.history.find(v => v.id === viewing)?.words ?? slot.words);
  const [draft, setDraft] = useState<Draft>(base);
  const was = slot.input.slot?.colors ?? [];
  const [colors, setColors] = useState<string[]>(was);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const points = (detail.materials?.sorted.points ?? []).map(p => ({ text: p.text, note: p.note ?? "", type: p.type }));
  const palette = detail.plan?.colors ?? [], multi = was.length > 1;
  const textChanged = (["title", "subtitle", "tags"] as const).some(k => toWords(draft)[k === "tags" ? "bullets" : k].toString() !== toWords(base)[k === "tags" ? "bullets" : k].toString());
  const colorsChanged = colors.join() !== was.join();
  const pictureChanged = draft.scene.trim() !== base.scene.trim() || note.trim() !== "" || colorsChanged;
  const cost = (n: number) => exempt ? "" : ` · ${n} 积分`;
  const at = slot.history.findIndex(v => v.id === viewing) + 1, current = slot.history.findIndex(v => v.id === slot.image) + 1;
  const submit = async (mode: "redraw" | "text") => {
    setSaving(true);
    try {
      await post(`projects/${detail.id}/redo`, { slot: slot.slot, mode, words: toWords(draft), note: mode === "redraw" ? note : "", base: viewing, ...(colorsChanged ? { colors } : {}) });
      await onDone(mode === "text" ? `${numOf(slot.slot)}开始改字，约 1 分钟` : `${numOf(slot.slot)}开始重画，约 1 分钟`);
    } catch (error) { onError((error as Error).message); } finally { setSaving(false); }
  };
  const choose = async () => {
    try { await post(`projects/${detail.id}/current`, { slot: slot.slot, asset: viewing }); await onDone(`已改用第 ${at} 版，下载也用这一版`); }
    catch (error) { onError((error as Error).message); }
  };
  const pick = (name: string) => setColors(c => multi ? (c.includes(name) ? (c.length > 1 ? c.filter(x => x !== name) : c) : [...c, name].slice(0, 4)) : [name]);
  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="改这一张">
        <div className="lp-box-head"><div><h3>改这一张 · {KIND_LABEL[kind]} {numOf(slot.slot)}{slot.input.slot?.role ? ` · ${slot.input.slot.role}` : ""}</h3><p className="lp-sub">只重出这一张，其他图不动；旧的那张会留着。</p></div><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <div className="lp-edit">
            <div className="lp-edit-pic">
              {viewing && <img src={`/api/listing/assets/${viewing}`} alt="" style={{ aspectRatio: SHAPE[kind] }} />}
              {slot.history.length > 1 && (
                <div className="lp-vers">以前的版本：{slot.history.map((v, i) => (
                  <button type="button" key={v.id} className={v.id === viewing ? "sel" : ""} title={`第 ${i + 1} 版`} onClick={() => { setViewing(v.id); setDraft(toDraft(v.words ?? slot.words)); setNote(""); }}>
                    <img src={`/api/listing/assets/${v.id}`} alt="" style={{ aspectRatio: SHAPE[kind] }} /></button>))}
                  {viewing === slot.image ? <span>正在用第 {current} 版</span> : <button type="button" className="lp-btn sm" onClick={() => void choose()}>改用第 {at} 版</button>}
                </div>)}
            </div>
            <div className="lp-form">
              {points.length > 0 && <label className="lp-field"><span>讲什么</span><select value="" onChange={e => { const p = points[Number(e.target.value)]; if (p) setDraft(d => ({ ...d, title: p.text, subtitle: p.note })); }}>
                <option value="">换一条卖点…</option>{points.map((p, i) => <option key={i} value={i}>{p.type ? `${p.type} · ` : ""}{p.text}</option>)}</select></label>}
              {FIELDS.map(([key, label, max, hint]) => (
                <label key={key} className="lp-field"><span>{label}</span>
                  {key === "scene"
                    ? <textarea className={draft[key].trim() !== base[key].trim() ? "edited" : ""} maxLength={max} placeholder={hint} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />
                    : <input className={draft[key].trim() !== base[key].trim() ? "edited" : ""} maxLength={max} placeholder={hint} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))} />}
                </label>))}
              {palette.length > 1 && <div className="lp-field"><span>颜色</span><div className="lp-chips">{palette.map(c => (
                <button type="button" key={c.sku} className={"lp-chip" + (colors.includes(c.name) ? " on" : "")} onClick={() => pick(c.name)}><span className="dotc" style={{ background: c.hex || "#999" }} />{c.name}</button>))}
                {multi && <small className="lp-muted">多选，最多 4 个</small>}</div></div>}
              <label className="lp-field"><span>其他要求</span><input maxLength={200} placeholder="可不填，比如：模特换成女生、背景更亮" value={note} onChange={e => setNote(e.target.value)} /></label>
              <div className={"lp-say" + (pictureChanged ? " y" : "")}>{pictureChanged ? "改了画面或颜色：整张重新生成，人物和背景会变，衣服不变。"
                : textChanged ? `只改了字：保留第 ${at} 版的画面，只把字换掉。想换个新画面，就点「整张重画」。`
                : "改一下上面的字、画面或颜色再提交；什么都不改，也可以直接整张重画一次。"}</div>
            </div>
          </div>
        </div>
        <div className="lp-box-foot">
          <div className="grow" />
          <button type="button" className={"lp-btn" + (textChanged && !pictureChanged ? "" : " primary")} disabled={saving || !draft.title.trim()} onClick={() => void submit("redraw")}>整张重画{cost(colors.length > 1 ? prices.multi : prices.image)}</button>
          {textChanged && !pictureChanged && <button type="button" className="lp-btn primary" disabled={saving || !draft.title.trim()} onClick={() => void submit("text")}>只改字{cost(prices.image)}</button>}
        </div>
      </div>
    </div>
  );
}
