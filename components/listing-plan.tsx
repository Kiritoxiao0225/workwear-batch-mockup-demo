"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图「定方案」: in three steps the user checks what the AI sorted out and decides everything
 * that costs money — each colour's garment image and the main colour, what every image says and
 * which colour it shows, the layout, the counts and extra cover sets. Nothing is paid before
 * 「开始出图」; the words here are the words printed on the images.
 */
import { useRef, useState } from "react";
import type { ListingCounts } from "@/lib/listing/layouts";
import { assignColors, draftImages, overLimit, planSlots, priceLines, slotsFor, syncCloser, thinOf, usableAsIs, type Draft, type Point, type PriceLine, type Slot } from "@/lib/listing/plan";

export const KINDS = ["颜色款图", "静物", "3D渲染", "模特实拍", "细节特写", "卖点图", "详情页", "海报", "尺码表", "无关"] as const;
export type Sorted = { id: string; kind: string; color: string; front: boolean; detail: string; text: boolean; logo: boolean; same: string };
export type Materials = {
  sorted: { images: Sorted[]; colors: { name: string; hex: string; from: string[] }[]; points: (Omit<Point, "note" | "why"> & { note?: string; why?: string })[]; notes: string[] };
  chosen: { colors: { name: string; hex: string; pick: string | null; candidates: string[] }[]; parts: { part: string; pick: string | null; candidates: string[] }[] };
  duplicates: [string, string][]; images: { label: string; assetId: string }[];
};
export type LayoutCard = { id: string; name: string; description: string; samples: string[]; own: boolean; by?: string; createdAt?: string };
export type Prices = { image: number; multi: number; exempt: boolean };
type Source = { id: string; label: string; path: string; url: string };

const pointsOf = (m: Materials): Point[] => m.sorted.points.map(p => ({ ...p, note: p.note ?? "", why: p.why ?? "" }));
const live = (d: Draft) => d.colors.filter(c => c.pick);

/** The AI's plan as the starting point: its picks, the points shared out, colours assigned by the rules. */
export function defaultDraft(m: Materials, layout: string, counts: ListingCounts): Draft {
  const colors = m.chosen.colors.map(c => ({ name: c.name, hex: c.hex, pick: c.pick }));
  const ok = colors.filter(c => c.pick), main = ok[0]?.name ?? colors[0]?.name ?? "";
  const { slots, poster } = planSlots(pointsOf(m), ok.map(c => c.name));
  return { colors, main, parts: m.chosen.parts.map(p => ({ part: p.part, pick: p.pick })), slots: assignColors(slots, ok, main), poster, layout, counts, extra: [] };
}

/** After the colours changed: the closer's count, the colours of every image and the extra sets follow. */
function recolor(d: Draft): Draft {
  const ok = live(d), names = ok.map(c => c.name), main = names.includes(d.main) ? d.main : names[0] ?? "";
  const slots = d.slots.map((s, i) => i === 4 ? syncCloser(s, names) : s);
  return { ...d, main, slots: assignColors(slots, ok, main), extra: d.extra.filter(e => names.includes(e.color) && e.color !== main) };
}

/** Red: generating is refused until fixed. Yellow: images with too few words. */
export function checkDraft(d: Draft) {
  const red = [
    ...d.colors.filter(c => !c.pick).map(c => `「${c.name}」没有衣服图：补传一张，或者不要这个颜色`),
    ...(d.parts.find(p => p.part === "正面全身")?.pick ? [] : ["缺正面全身图：补传一张"]),
    ...(live(d).length ? [] : ["没有颜色了：至少留一个"]),
  ];
  const used = slotsFor(Math.max(d.counts.square, d.counts.portrait));
  for (const i of used) { const long = overLimit(d.slots[i]); if (long) red.push(`第 ${used.indexOf(i) + 1} 张${long}`); }
  if (d.counts.poster && overLimit(d.poster)) red.push(`海报${overLimit(d.poster)}`);
  const thin = used.filter(i => thinOf(d.slots[i], i)).length;
  return { red, thin };
}

/** What the server is sent: the words, colours and picks, nothing the page only shows. */
export const payload = (d: Draft) => ({
  ...d, colors: live(d).map(c => ({ name: c.name.trim(), hex: c.hex, pick: c.pick })),
  slots: d.slots.map(s => ({ role: s.role, title: s.title.trim(), sub: s.sub.trim(), tags: s.tags, colors: s.colors })),
});

export function draftPrice(d: Draft, m: Materials, prices: Prices) {
  const sorted = new Map(m.sorted.images.map(i => [i.id, i]));
  const direct = new Set(live(d).filter(c => usableAsIs(sorted.get(c.pick!))).map(c => c.pick!));
  const lines = priceLines(draftImages(d, direct), prices.image, prices.multi);
  return { lines, images: lines.reduce((n, l) => n + l.count, 0), credits: lines.reduce((n, l) => n + l.credits, 0) };
}

/** ⓘ next to a credit amount: hover (or tap) shows how it adds up. */
export function PriceInfo({ lines, total, extra }: { lines: PriceLine[]; total: number; extra?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="lp-price" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="lp-i" aria-label="费用明细" onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>i</button>
      {open && <span className="lp-pop" role="tooltip">
        <b>约 {total} 积分</b>
        {lines.map((l, i) => <span key={i} className="ln"><span>{l.label}</span><span>{l.count} 张 × {l.unit}</span><span>= {l.credits}</span>{l.note && <small>{l.note}</small>}</span>)}
        {extra && <small>{extra}</small>}
        <small>1 积分 = ¥0.01，约 ¥{(total / 100).toFixed(2)}。先冻结，没做出来的退回。</small>
      </span>}
    </span>
  );
}

const STEPS = ["① 颜色和衣服图", "② 每张图讲什么", "③ 版式、张数、出几套"];
const ROLE_HINT: Record<string, string> = { 首图: "定位做大标题，标签放最强的两条", 功能: "讲功能和面料", 细节: "做工和实用设计的特写", 实用: "实用设计的演示", 收口: "颜色和适合的人，推动下单" };
const WANT: Record<string, string> = { 正面全身: "衣服完整的正面图", 领口: "领子的特写", 拉链和袖口: "拉链、袖口的特写", 口袋: "口袋的特写", 面料: "面料纹理或功能演示的特写", 背面: "衣服背面" };
type Target = { kind: "color" | "part"; index: number } | null;

export function PlanDialog({ name, materials, sources, draft, layouts, prices, onChange, onUpload, onLearn, onManage, onClose, onStart }: {
  name: string; materials: Materials; sources: Source[]; draft: Draft; layouts: LayoutCard[]; prices: Prices;
  onChange: (d: Draft) => void; onUpload: (file: File) => Promise<{ label: string; url: string }>; onLearn: () => void; onManage: () => void; onClose: () => void; onStart: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [target, setTarget] = useState<Target>(null);
  const [tab, setTab] = useState("推荐");
  const [libTab, setLibTab] = useState("全部");
  const [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const sorted = new Map(materials.sorted.images.map(i => [i.id, i]));
  const byLabel = new Map(materials.images.map(i => [i.label, { label: i.label, url: `/api/listing/assets/${i.assetId}`, path: sources.find(s => s.id === i.assetId)?.path ?? i.label }]));
  const copies = [...materials.duplicates.map(([copy, keep]) => ({ copy, keep })), ...materials.sorted.images.filter(i => i.same).map(i => ({ copy: i.id, keep: i.same }))];
  const library = [...byLabel.values()].filter(i => !copies.some(c => c.copy === i.label));
  const points = pointsOf(materials);
  const check = checkDraft(draft), cost = draftPrice(draft, materials, prices), ok = live(draft);
  const used = slotsFor(Math.max(draft.counts.square, draft.counts.portrait));
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setSlot = (i: number, patch: Partial<Slot>) => set({ slots: draft.slots.map((s, k) => k === i ? { ...s, ...patch } : s) });
  const kindOf = (label: string | null) => (label && sorted.get(label)?.kind) || "补传";
  const candidates = (t: NonNullable<Target>) => {
    if (t.kind === "color") {
      const c = draft.colors[t.index], chosen = materials.chosen.colors.find(x => x.name === c.name)?.candidates ?? [];
      return library.filter(i => chosen.includes(i.label) || sorted.get(i.label)?.color === c.name);
    }
    const part = draft.parts[t.index].part, chosen = materials.chosen.parts.find(x => x.part === part)?.candidates ?? [];
    return library.filter(i => chosen.includes(i.label) || (part !== "正面全身" && sorted.get(i.label)?.kind === "细节特写"));
  };
  const assign = (label: string) => {
    if (!target) return;
    if (target.kind === "color") onChange(recolor({ ...draft, colors: draft.colors.map((c, k) => k === target.index ? { ...c, pick: label } : c) }));
    else set({ parts: draft.parts.map((p, k) => k === target.index ? { ...p, pick: label } : p) });
    setTarget(null);
  };
  const shown = target ? (tab === "推荐" ? candidates(target) : library.filter(i => tab === "全部" || sorted.get(i.label)?.kind === tab)) : [];
  const pic = (label: string | null) => label && byLabel.get(label) ? <img src={byLabel.get(label)!.url} alt="" loading="lazy" /> : null;
  const sayings = new Set(draft.slots.filter((_, i) => used.includes(i)).flatMap(s => [s.title, ...s.tags]));
  const spare = points.filter(p => !sayings.has(p.text));
  const go = (n: number) => setStep(check.red.length ? 1 : Math.max(1, Math.min(3, n)));
  const swap = (i: number, k: string) => { const p = points[Number(k)]; if (p) setSlot(i, { title: p.text, sub: p.note, tags: draft.slots[i].tags.filter(t => t !== p.text) }); };
  const pickColor = (i: number, c: string) => {
    const s = draft.slots[i];
    const colors = i === 4 ? (s.colors.includes(c) ? s.colors.filter(x => x !== c) : [...s.colors, c].slice(0, 4)) : [c];
    onChange({ ...draft, slots: assignColors(draft.slots.map((x, k) => k === i ? { ...x, colors: colors.length ? colors : [c], manual: true } : x), ok, draft.main) });
  };
  const step1 = (<>
    <div className={"lp-alert " + (check.red.length ? "r" : "g")}>{check.red.length ? "✕ " + check.red.join("；") : "✓ 每个颜色都有衣服图，正面全身也有"}
      {materials.sorted.notes.length > 0 && <small>AI 的提醒：{materials.sorted.notes.join("；")}</small>}</div>
    <h4 className="lp-h">每个颜色的衣服 <small>出图时只看这里的图：每色 1 张。干净的静物图直接当白底图，不收费。颜色名照抄素材。</small></h4>
    <div className="lp-mcards">{draft.colors.map((c, i) => {
      const isMain = draft.main === c.name;
      return (
        <div key={i} className={"lp-mcard" + (c.pick ? "" : " missing") + (isMain ? " main" : "")}>
          {isMain && <span className="lp-badge">主推色</span>}
          {c.pick ? <div className="pic">{pic(c.pick)}<span className="src">{kindOf(c.pick)}</span></div> : <div className="pic">没找到「{c.name}」的衣服图<br />（素材里提到了这个颜色）</div>}
          <div className="row"><span className="dotc" style={{ background: c.hex || "#999" }} /><input value={c.name} maxLength={12} aria-label="颜色名"
            onChange={e => { const nameNow = e.target.value; onChange(recolor({ ...draft, main: isMain ? nameNow : draft.main, colors: draft.colors.map((x, k) => k === i ? { ...x, name: nameNow } : x),
              slots: draft.slots.map(s => ({ ...s, colors: s.colors.map(n => n === c.name ? nameNow : n) })), extra: draft.extra.map(e2 => e2.color === c.name ? { ...e2, color: nameNow } : e2) })); }} /></div>
          {c.pick && <label className={"lp-star" + (isMain ? " on" : "")}><input type="radio" name="main" checked={isMain} onChange={() => onChange(recolor({ ...draft, main: c.name, slots: draft.slots.map(s => s.colors.includes(c.name) ? { ...s, manual: false } : s) }))} /> {isMain ? "首图和海报用这个颜色" : "设为主推色"}</label>}
          <div className="row"><button type="button" className={"lp-btn sm" + (c.pick ? "" : " primary")} onClick={() => { setTab("推荐"); setTarget({ kind: "color", index: i }); }}>{c.pick ? "换一张" : "补传 / 选图"}</button>
            <button type="button" className="lp-btn link" onClick={() => { if (window.confirm(`去掉颜色「${c.name}」？这个颜色不出 SKU 图，也不出现在主图里。`)) onChange(recolor({ ...draft, colors: draft.colors.filter((_, k) => k !== i) })); }}>不要这个颜色</button></div>
        </div>);
    })}</div>
    <p className="lp-say"><b>主推色</b>就是首图和海报用的颜色。想用别的颜色也出首图（比如做不同链接），在第 ③ 步「出几套」里加。</p>
    <h4 className="lp-h">衣服结构图 <small>AI 照着这些图写衣服的样子，图本身不会出现在成品里。找不到的部位，出图时自动不画。点图可以换。</small></h4>
    <div className="lp-parts">{draft.parts.map((p, i) => (
      <button type="button" key={p.part} className={"lp-part" + (!p.pick && p.part === "正面全身" ? " missing" : "")} onClick={() => { setTab("推荐"); setTarget({ kind: "part", index: i }); }}>
        {p.pick ? pic(p.pick) : <span className="none">{p.part === "正面全身" ? "缺正面全身图，点这里补" : `没找到${p.part}图，出图时不画`}</span>}{p.part}</button>))}
    </div>
    <details className="lp-all">
      <summary>查看全部素材：整理后 {library.length} 张，合并重复 {copies.length} 张</summary>
      <div className="lp-tabs">{["全部", ...KINDS.filter(k => library.some(i => sorted.get(i.label)?.kind === k)), "重复（已合并）"].map(k => (
        <button type="button" key={k} className={libTab === k ? "on" : ""} onClick={() => setLibTab(k)}>{k} {k === "全部" ? library.length : k === "重复（已合并）" ? copies.length : library.filter(i => sorted.get(i.label)?.kind === k).length}</button>))}</div>
      <div className="lp-lib">{libTab === "重复（已合并）"
        ? copies.map(c => byLabel.get(c.copy) && <a key={c.copy} className="it" href={byLabel.get(c.copy)!.url} target="_blank" rel="noreferrer"><img src={byLabel.get(c.copy)!.url} alt="" loading="lazy" /><span className="cat">同 {c.keep}</span><small>{byLabel.get(c.copy)!.path}</small></a>)
        : library.filter(i => libTab === "全部" || sorted.get(i.label)?.kind === libTab).map(i => (
          <a key={i.label} className="it" href={i.url} target="_blank" rel="noreferrer"><img src={i.url} alt="" loading="lazy" /><span className="cat">{sorted.get(i.label)?.kind}{sorted.get(i.label)?.color ? "·" + sorted.get(i.label)!.color : ""}</span><small>{i.path}</small></a>))}</div>
    </details>
  </>);
  const step2 = (<>
    <p className="lp-say">AI 先把卖点按类型分好：<b>首图</b>放定位和最强的两条，<b>收口</b>讲几色可选，中间几张按卖点分量分给各类型，同类卖点在一张图里讲完。<b>这里写的字就是印到图上的字。</b>3:4 主图讲的和 1:1 一样，颜色也一样，只换排版。<br />
      <b>颜色：</b>首图和海报用主推色；中间几张每张换一个颜色，细节图挑浅色和中间色，功能图挑中间色、跟首图拉开；收口是主推色加深、浅、中间色各一个。不合适直接点颜色改。</p>
    <div className="lp-slots">{used.map((i, k) => {
      const s = draft.slots[i], thin = thinOf(s, i);
      return (
        <div key={i} className={"lp-slot" + (thin ? " warn" : "")}>
          <div className="who"><b>第 {k + 1} 张</b><span>{s.role}</span><small>{ROLE_HINT[s.role]}</small></div>
          <div className="lp-fields">
            <label>讲什么</label><select value="" onChange={e => swap(i, e.target.value)}><option value="">换一条卖点…</option>
              {[...new Set(points.map(p => p.type))].map(t => <optgroup key={t} label={t || "其他"}>{points.map((p, n) => p.type === t ? <option key={n} value={n}>{p.text}</option> : null)}</optgroup>)}</select>
            <label>大标题</label><input className="big" value={s.title} maxLength={20} onChange={e => setSlot(i, { title: e.target.value })} />
            <label>小字</label><input value={s.sub} maxLength={30} placeholder={i === 0 ? "首图可以不写小字" : "一句说明"} onChange={e => setSlot(i, { sub: e.target.value })} />
            <label>标签</label><div className="lp-chips">{s.tags.map((t, n) => <span key={n} className="lp-tagx">{t}<button type="button" aria-label="去掉" onClick={() => setSlot(i, { tags: s.tags.filter((_, m) => m !== n) })}>×</button></span>)}
              {s.tags.length < 3 && <select value="" onChange={e => e.target.value && setSlot(i, { tags: [...s.tags, e.target.value] })}><option value="">＋ 加标签</option>{points.filter(p => p.text !== s.title && !s.tags.includes(p.text)).map((p, n) => <option key={n}>{p.text}</option>)}</select>}</div>
            <label>颜色</label><div className="lp-chips">{ok.map(c => (
              <button type="button" key={c.name} className={"lp-chip" + (s.colors.includes(c.name) ? " on" : "")} disabled={i === 0} onClick={() => pickColor(i, c.name)}><span className="dotc" style={{ background: c.hex || "#999" }} />{c.name}</button>))}</div>
            <span /><small className="lp-muted">{i === 0 ? "首图跟主推色，在第 ① 步改" : `${i === 4 ? "多选，最多 4 个" : "单选"} · ${s.why ?? ""}`}{s.manual && <button type="button" className="lp-btn link" onClick={() => onChange({ ...draft, slots: assignColors(draft.slots.map((x, m) => m === i ? { ...x, manual: false } : x), ok, draft.main) })}>按规则重排</button>}</small>
            {thin && <><span /><small className="lp-warn">! {thin}</small></>}
          </div>
        </div>);
    })}</div>
    {draft.counts.poster > 0 && <>
      <h4 className="lp-h">2:3 首页海报 <small>用主推色，画面氛围感最强</small></h4>
      <div className="lp-slot"><div className="who"><b>海报</b></div><div className="lp-fields">
        <label>大标题</label><input className="big" value={draft.poster.title} maxLength={20} onChange={e => set({ poster: { ...draft.poster, title: e.target.value } })} />
        <label>小字</label><input value={draft.poster.sub} maxLength={30} onChange={e => set({ poster: { ...draft.poster, sub: e.target.value } })} /></div></div></>}
    {spare.length > 0 && <><h4 className="lp-h">没用上的卖点 <small>点一下，加到第一张还有空位的图的标签里</small></h4>
      <div className="lp-chips">{spare.map((p, n) => <button type="button" key={n} className="lp-chip" onClick={() => {
        const i = used.find(x => x > 0 && draft.slots[x].tags.length < 3);
        if (i !== undefined) setSlot(i, { tags: [...draft.slots[i].tags, p.text] });
      }}>＋ {p.text} <small className="lp-muted">{p.type}</small></button>)}</div></>}
  </>);
  const free = ok.filter(c => c.name !== draft.main && !draft.extra.some(e => e.color === c.name));
  const step3 = (<>
    <h4 className="lp-h">版式 <small>只管图长什么样，不管讲什么</small></h4>
    <div className="lp-layouts">{layouts.map(l => (
      <button type="button" key={l.id} className={"lp-layout" + (l.id === draft.layout ? " on" : "")} onClick={() => set({ layout: l.id })}>
        <span className="ok">✓</span><span className={"lp-tag" + (l.own ? " team" : "")}>{l.own ? "团队学的" : "自带"}</span>
        <div className="pics">{l.samples.map(src => <img key={src} src={src} alt="" />)}</div><b>{l.name}</b><p>{l.description}</p></button>))}
      <button type="button" className="lp-layout add" onClick={onLearn}><b>＋ 学一个新版式</b><p>上传几张喜欢的主图，AI 学它的风格和排法</p></button>
    </div>
    <p><button type="button" className="lp-btn link" onClick={onManage}>管理团队的版式</button></p>
    <h4 className="lp-h">出几张</h4>
    <div className="lp-counts">{([["square", "1:1 主图", 5], ["portrait", "3:4 主图", 5], ["poster", "2:3 海报", 1]] as const).map(([key, label, max]) => (
      <span key={key} className="lp-cnt">{label}<span className="lp-stepper"><button type="button" aria-label={`${label}减少`} onClick={() => { const counts = { ...draft.counts, [key]: Math.max(0, draft.counts[key] - 1) }; if (counts.square + counts.portrait + counts.poster) set({ counts }); }}>−</button><b>{draft.counts[key]}</b>
        <button type="button" aria-label={`${label}增加`} onClick={() => set({ counts: { ...draft.counts, [key]: Math.min(max, draft.counts[key] + 1) } })}>+</button></span></span>))}</div>
    <h4 className="lp-h">出几套 <small>想用不同颜色做不同链接，或者多试一种版式，就加一套首图</small></h4>
    <div className="lp-sets">
      <div className="lp-set main"><b>主推套 · {draft.main}</b><span>1:1 {draft.counts.square} 张 + 3:4 {draft.counts.portrait} 张 + 海报 {draft.counts.poster} 张，另有每色白底图和 SKU 图</span></div>
      {draft.extra.map((e, k) => (
        <div key={k} className="lp-set"><b>加一套首图</b>
          颜色 <select value={e.color} onChange={x => set({ extra: draft.extra.map((y, m) => m === k ? { ...y, color: x.target.value } : y) })}>{ok.filter(c => c.name === e.color || free.includes(c)).map(c => <option key={c.name}>{c.name}</option>)}</select>
          版式 <select value={e.layout} onChange={x => set({ extra: draft.extra.map((y, m) => m === k ? { ...y, layout: x.target.value } : y) })}><option value="">跟主推套一样</option>{layouts.filter(l => l.id !== draft.layout).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <span className="grow">1:1 首图 + 3:4 首图 + 海报，其余图共用</span><button type="button" className="lp-btn link" onClick={() => set({ extra: draft.extra.filter((_, m) => m !== k) })}>不要了</button></div>))}
      {free.length > 0 && <div><button type="button" className="lp-btn sm" onClick={() => set({ extra: [...draft.extra, { color: free[0].name, layout: "" }] })}>＋ 再加一套首图（换个颜色）</button></div>}
    </div>
    {!prices.exempt && <><h4 className="lp-h">费用</h4>
      <table className="lp-ptable"><tbody>{cost.lines.map((l, i) => <tr key={i}><td>{l.label}{l.note && <small> {l.note}</small>}</td><td>{l.count} 张</td><td>× {l.unit}</td><td>{l.unit ? l.credits : "免费"}</td></tr>)}
        <tr className="total"><td>合计</td><td>{cost.images} 张</td><td /><td>约 {cost.credits} 积分</td></tr></tbody></table></>}
  </>);
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan" role="dialog" aria-modal="true" aria-label="定方案">
        <div className="lp-box-head"><div><h3>定方案 · {name}</h3><p className="lp-sub">AI 已经整理好素材，下面每一项都是它的建议，不对的直接改。点「开始出图」之前不花钱。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-stepbar">{STEPS.map((s, i) => <button type="button" key={s} className={step === i + 1 ? "on" : i === 0 && check.red.length ? "bad" : i === 1 && check.thin ? "warn" : "ok"} onClick={() => go(i + 1)}>{s}</button>)}</div>
        <div className="lp-box-body" key={step}>{step === 1 ? step1 : step === 2 ? step2 : step3}</div>
        <div className="lp-box-foot">
          <div className="grow">{check.red.length ? <span className="lp-bad">{check.red[0]}</span> : <>共 {cost.images} 张（含白底图和 SKU 图）{!prices.exempt && <>，约 <b>{cost.credits}</b> 积分 <PriceInfo lines={cost.lines} total={cost.credits} extra="分析费已在整理时扣过" /></>}{check.thin > 0 && <span className="lp-warn"> · {check.thin} 张图字偏少</span>}</>}</div>
          {step > 1 && <button type="button" className="lp-btn" onClick={() => go(step - 1)}>上一步</button>}
          {step < 3 ? <button type="button" className="lp-btn primary" disabled={check.red.length > 0} onClick={() => go(step + 1)}>下一步</button>
            : <button type="button" className="lp-btn primary" disabled={busy || check.red.length > 0} onClick={async () => { setBusy(true); try { await onStart(); } finally { setBusy(false); } }}>{busy ? "正在开始…" : `开始出图${prices.exempt ? "" : ` · 约 ${cost.credits} 积分`}`}</button>}
        </div>
      </div>

      {target && (
        <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) setTarget(null); }}>
          <div className="lp-box" role="dialog" aria-modal="true" aria-label="选一张图">
            <div className="lp-box-head"><div><h3>{target.kind === "color" ? `选「${draft.colors[target.index].name}」的衣服图` : `选结构图「${draft.parts[target.index].part}」`}</h3>
              <p className="lp-sub">{target.kind === "color" ? "要衣服完整、正面、颜色准。推荐里是 AI 认为是这个颜色的图。" : WANT[draft.parts[target.index].part]}</p></div>
              <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={() => setTarget(null)}>关闭</button></div>
            <div className="lp-box-body">
              <div className="lp-tabs">{["推荐", "全部", ...KINDS].map(k => <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}</div>
              <div className="lp-lib">{shown.length ? shown.map(i => (
                <button type="button" key={i.label} className="it" onClick={() => assign(i.label)}><img src={i.url} alt="" loading="lazy" /><span className="cat">{sorted.get(i.label)?.kind}{sorted.get(i.label)?.color ? "·" + sorted.get(i.label)!.color : ""}</span><small>{i.path}</small></button>))
                : <span className="lp-muted">素材里没有推荐的图，可以看「全部」或补传一张。</span>}</div>
            </div>
            <div className="lp-box-foot"><div className="grow">{target.kind === "part" && draft.parts[target.index].pick && draft.parts[target.index].part !== "正面全身"
              ? <button type="button" className="lp-btn link" onClick={() => { set({ parts: draft.parts.map((p, k) => k === target.index ? { ...p, pick: null } : p) }); setTarget(null); }}>不用这个部位（出图时不画）</button> : "素材里没有合适的？"}</div>
              <button type="button" className="lp-btn" disabled={busy} onClick={() => upload.current?.click()}>{busy ? "正在上传…" : "补传一张"}</button>
              <input ref={upload} type="file" accept="image/*" hidden onChange={async e => {
                const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
                setBusy(true); try { const added = await onUpload(file); assign(added.label); } catch { /* the page says why */ } finally { setBusy(false); }
              }} /></div>
          </div>
        </div>)}
    </div>
  );
}
