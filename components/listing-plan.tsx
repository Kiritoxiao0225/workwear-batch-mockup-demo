"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图「定方案」, three steps: each colour's garment image; the layout, the model and the
 * counts; then 卖点上图 — the points on the left (the material's own and the ones competitors
 * show, each saying where it is used) and the images on the right (what each card shows and how,
 * the heading the AI wrote). A point's words are kept in one place, the list; the images use them.
 * Nothing is paid before 「开始出图」; the words here are the words printed on the images.
 */
import { useRef, useState } from "react";
import type { LayoutCard, Materials, Source } from "@/lib/listing/api-types";
import { assetUrl } from "@/lib/listing/client-api";
import { categoryById, GROUP_HINT, GROUP_LABEL, TASK_HINT, TASK_LABEL, type Task } from "@/lib/listing/category";
import {
  checkDraft, colorize, defaultDraft, draftImages, FRONT, LIMITS, notesOf, placesFor, priceLines, proofsFor, renamePoint, replan, showsGarment, structureHint, sumCredits, syncCloser,
  templateFor, tickPoint, usableAsIs, usageOf, usedSlots, fitProof, fillParts, missingParts, partOf,
  type Counts, type Draft, type Point, type PriceLine, type Slot,
} from "@/lib/listing/draft";
import { proofById } from "@/lib/listing/proofs";
import { capacity, cellZones, needsCast, PEOPLE_LABEL, type Layout } from "@/lib/listing/templates";
import { SlotPreview, Wire } from "./listing-wire";
import { KeptPreview, ServiceBar, ServicePick } from "./listing-service";

export const KINDS = ["颜色款图", "静物", "3D渲染", "模特实拍", "细节特写", "卖点图", "详情页", "海报", "尺码表", "无关"] as const;
export type Prices = { image: number; multi: number; exempt: boolean };

const live = (d: Draft) => d.colors.filter(c => c.pick);
const len = (s: string) => [...s.trim()].length;
export const layoutOf = (layouts: LayoutCard[], id: string): Layout => layouts.find(l => l.id === id) ?? layouts[0];

/** The AI's plan as the starting point; `category` overrides the AI's call. */
export function startDraft(m: Materials, layout: Layout, counts?: Counts, category = m.category): Draft {
  return fillParts(defaultDraft({ category, categoryWhy: m.categoryWhy, checks: m.checks, titles: m.titles, points: m.sorted.points, colors: m.chosen.colors, parts: m.chosen.parts }, layout, counts), m.sorted.images);
}
/** After the colours changed: the closer's count, the colours of every image and the extra sets follow. */
function recolor(d: Draft, layout: Layout): Draft {
  const ok = live(d), names = ok.map(c => c.name), main = names.includes(d.main) ? d.main : names[0] ?? "";
  const next = { ...d, main, extra: d.extra.filter(e => names.includes(e.color) && e.color !== main) };
  return { ...next, slots: colorize(next, layout, d.slots.map((s, i) => i === d.slots.length - 1 ? syncCloser(s, names) : s)) };
}

/** The two rounds' images and credits: round one at 「开始出图」, round two at 「出竖版」. */
export function draftPrice(d: Draft, m: Materials, layout: Layout, prices: Prices) {
  const sorted = new Map(m.sorted.images.map(i => [i.id, i]));
  const direct = new Set(live(d).filter(c => usableAsIs(sorted.get(c.pick!))).map(c => c.pick!));
  const items = draftImages(d, layout, direct);
  const round = (r: 1 | 2) => { const lines = priceLines(items.filter(i => i.round === r), prices.image, prices.multi); return { lines, images: lines.reduce((n, l) => n + l.count, 0), credits: sumCredits(lines) }; };
  return { now: round(1), later: round(2) };
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

const STEPS = ["① 颜色和衣服图", "② 版式、模特、张数", "③ 卖点上图"];
type Target = { kind: "color" | "part"; index: number } | null;
const SEEN_TEXT = { 有: "看得出有", 看不出: "看图看不出", 不像: "看着不像有" } as const;

export function PlanDialog({ name, materials, sources, draft, layouts, prices, onChange, onUpload, onLearn, onManage, onService, onClose, onStart }: {
  name: string; materials: Materials; sources: Source[]; draft: Draft; layouts: LayoutCard[]; prices: Prices;
  onChange: (d: Draft) => void; onUpload: (file: File) => Promise<{ label: string }>; onLearn: () => void; onManage: () => void; onService: () => void; onClose: () => void; onStart: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [target, setTarget] = useState<Target>(null);
  const [tab, setTab] = useState("推荐");
  const [libTab, setLibTab] = useState("全部");
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<{ id: string; all: boolean } | null>(null);
  const [hover, setHover] = useState<{ slot: number; zones: string[] } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const layout = layoutOf(layouts, draft.layout), category = categoryById(draft.category);
  const sorted = new Map(materials.sorted.images.map(i => [i.id, i]));
  const byLabel = new Map(materials.images.map(i => [i.label, { label: i.label, url: assetUrl(i.assetId), path: sources.find(s => s.id === i.assetId)?.path ?? i.label }]));
  const copies = [...materials.duplicates.map(([copy, keep]) => ({ copy, keep })), ...materials.sorted.images.filter(i => i.same).map(i => ({ copy: i.id, keep: i.same }))];
  const library = [...byLabel.values()].filter(i => !copies.some(c => c.copy === i.label));
  const check = checkDraft(draft, layout), cost = draftPrice(draft, materials, layout, prices), ok = live(draft);
  const used = usedSlots(draft, draft.counts.square), usage = usageOf(draft), hint = structureHint(draft, layout);
  const pointOf = (id: string | null | undefined) => draft.points.find(p => p.id === id);
  const on = draft.points.filter(p => p.on && p.type !== "定位");
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const kindOf = (label: string | null) => (label && sorted.get(label)?.kind) || "补传";
  const candidates = (t: NonNullable<Target>) => {
    if (t.kind === "color") {
      const c = draft.colors[t.index], chosen = materials.chosen.colors.find(x => x.name === c.name)?.candidates ?? [];
      return library.filter(i => chosen.includes(i.label) || sorted.get(i.label)?.color === c.name);
    }
    const part = draft.parts[t.index]?.part ?? "", chosen = materials.chosen.parts.find(x => x.part === part)?.candidates ?? [];
    return library.filter(i => chosen.includes(i.label) || (part !== FRONT && sorted.get(i.label)?.kind === "细节特写"));
  };
  const assign = (label: string) => {
    if (!target) return;
    if (target.kind === "color") onChange(recolor({ ...draft, colors: draft.colors.map((c, k) => k === target.index ? { ...c, pick: label } : c) }, layout));
    else set({ parts: draft.parts.map((p, k) => k === target.index ? { ...p, pick: label } : p) });
    setTarget(null);
  };
  const shown = target ? (tab === "推荐" ? candidates(target) : library.filter(i => tab === "全部" || sorted.get(i.label)?.kind === tab)) : [];
  const pic = (label: string | null) => label && byLabel.get(label) ? <img src={byLabel.get(label)!.url} alt="" loading="lazy" /> : null;
  const go = (n: number) => setStep(check.red.length && n > 1 ? 1 : Math.max(1, Math.min(3, n)));
  const pickColor = (i: number, c: string) => {
    const s = draft.slots[i], last = i === draft.slots.length - 1;
    const colors = last ? (s.colors.includes(c) ? s.colors.filter(x => x !== c) : [...s.colors, c].slice(0, 4)) : [c];
    onChange({ ...draft, slots: colorize(draft, layout, draft.slots.map((x, k) => k === i ? { ...x, colors: colors.length ? colors : [c], manual: true } : x)) });
  };
  const jump = (k: number) => { setStep(3); setTimeout(() => document.getElementById(`lp-img-${used[k - 1]}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };

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
              slots: draft.slots.map(s => ({ ...s, colors: s.colors.map(n => n === c.name ? nameNow : n) })), extra: draft.extra.map(e2 => e2.color === c.name ? { ...e2, color: nameNow } : e2) }, layout)); }} /></div>
          {c.pick && <label className={"lp-star" + (isMain ? " on" : "")}><input type="radio" name="main" checked={isMain} onChange={() => onChange(recolor({ ...draft, main: c.name, slots: draft.slots.map(s => s.colors.includes(c.name) ? { ...s, manual: false } : s) }, layout))} /> {isMain ? "首图和长图用这个颜色" : "设为主推色"}</label>}
          <div className="row"><button type="button" className={"lp-btn sm" + (c.pick ? "" : " primary")} onClick={() => { setTab("推荐"); setTarget({ kind: "color", index: i }); }}>{c.pick ? "换一张" : "补传 / 选图"}</button>
            <button type="button" className="lp-btn link" onClick={() => { if (window.confirm(`去掉颜色「${c.name}」？这个颜色不出 SKU 图，也不出现在主图里。`)) onChange(recolor({ ...draft, colors: draft.colors.filter((_, k) => k !== i) }, layout)); }}>不要这个颜色</button></div>
        </div>);
    })}</div>
    <p className="lp-say"><b>主推色</b>就是首图和长图用的颜色。想用别的颜色也出首图（比如做不同链接），在第 ② 步「出几套」里加。</p>
    <h4 className="lp-h">衣服结构图 <small>给 AI 看清这件衣服各部位长什么样，保证每张图里衣服画得一样。细节图只能拍这里有图的部位；部位名字可以改、加、删。</small></h4>
    <div className="lp-parts">{draft.parts.map((p, i) => (
      <div key={i} className={"lp-part" + (!p.pick && p.part === FRONT ? " missing" : "")}>
        <button type="button" className="pic" title="换一张" onClick={() => { setTab("推荐"); setTarget({ kind: "part", index: i }); }}>
          {p.pick ? pic(p.pick) : <span className="none">{p.part === FRONT ? "缺正面全身图，点这里补" : "还没选图，点这里选"}</span>}</button>
        {p.part === FRONT ? <span className="nm">{FRONT}</span>
          : <><input value={p.part} maxLength={12} placeholder="部位名" aria-label="部位名" onChange={e => set({ parts: draft.parts.map((x, k) => k === i ? { ...x, part: e.target.value } : x) })} />
            <button type="button" className="lp-btn link" onClick={() => set({ parts: draft.parts.filter((_, k) => k !== i) })}>删掉</button></>}
      </div>))}
      <div className="lp-part"><button type="button" className="pic" onClick={() => { set({ parts: [...draft.parts, { part: "新部位", pick: null }] }); setTab("全部"); setTarget({ kind: "part", index: draft.parts.length }); }}><span className="none add">＋ 加一个部位</span></button></div>
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


  /* ② 版式、模特、张数 */
  const cast = needsCast(layout, category.tasks);
  const free = ok.filter(c => c.name !== draft.main && !draft.extra.some(e => e.color === c.name));
  const peopleLine = (l: Layout) => category.tasks.map(t => `${TASK_LABEL[t]}${PEOPLE_LABEL(l.templates[t].square)}`).join(" · ");
  const setCount = (key: keyof Counts, n: number) => {
    const counts = { ...draft.counts, [key]: n };
    if (key === "square") counts.portrait = Math.min(counts.portrait, n);
    set({ counts });
  };
  const layoutStep = (<>
    <h4 className="lp-h">版式 <small>定每张图长什么样：格子放哪、标签放哪、哪张有人。下一步按它的格子放卖点，每张几格跟着卖点多少走</small></h4>
    <div className="lp-layouts">{layouts.map(l => (
      <button type="button" key={l.id} className={"lp-layout" + (l.id === draft.layout ? " on" : "")} onClick={() => onChange(replan(draft, l))}>
        <span className="ok">✓</span><span className={"lp-tag" + (l.own ? " team" : "")}>{l.own ? "团队学的" : "自带"}</span>
        <div className="pics">{l.samples.map(src => <img key={src} src={src} alt="" />)}</div>
        <div className="wires">{(["首图", "功能", "细节"] as Task[]).map(t => <span key={t}><Wire template={l.templates[t].square} width={58} /><small>{TASK_LABEL[t]}</small></span>)}</div>
        <b>{l.name}</b><p>{l.description}</p><p className="ppl">{peopleLine(l)}</p></button>))}
      <button type="button" className="lp-layout add" onClick={onLearn}><b>＋ 学一个新版式</b><p>上传几张喜欢的主图，AI 学它的风格、排法和哪张有人</p></button>
    </div>
    <p className="lp-muted lp-small">上面的样图看风格（字体、颜色、光线），小格子图看排法。<button type="button" className="lp-btn link" onClick={onManage}>管理团队的版式</button></p>
    <h4 className="lp-h">模特</h4>
    {cast ? <div className="lp-model">
      <div className="lp-chips">{(["男", "女"] as const).map(g => <label key={g} className={"lp-chip" + (draft.model.lead === g ? " on" : "")}><input type="radio" name="lead" hidden checked={draft.model.lead === g} onChange={() => set({ model: { lead: g } })} />单人的图用{g === "男" ? "男生" : "女生"}</label>)}</div>
      <p className="lp-say">开始出图时先出一张<b>模特定妆照</b>（一男一女，浅灰背景），后面所有有人的图都照它画，<b>是同一个人</b>。单人的图用上面选的主模特，双人的图一男一女，多人的图两位都在、其余男女交替。定妆照不满意，出图后可以「换一组模特」。<br />这个版式有人的图：{category.tasks.filter(t => layout.templates[t].square.people > 0).map(t => TASK_LABEL[t]).join("、") || "无"}{layout.long.people ? "、长图" : ""}{layout.sku.people ? "、SKU 图" : ""}。</p>
    </div> : <p className="lp-say">这个版式所有图都没有人，不出模特定妆照，也不用选模特。</p>}
    <h4 className="lp-h">出几张 <small>先出 1:1，在画板上改满意了，再一键出 3:4 和 2:3。1:1 少于 5 张时，留讲得最多的那几张</small></h4>
    <div className="lp-counts">{([["square", "1:1 主图", 1, 5], ["portrait", "3:4 主图", 0, draft.counts.square], ["long", "2:3 长图", 0, 1]] as const).map(([key, label, min, max]) => (
      <span key={key} className="lp-cnt">{label}<span className="lp-stepper"><button type="button" aria-label={`${label}减少`} disabled={draft.counts[key] <= min} onClick={() => setCount(key, draft.counts[key] - 1)}>−</button><b>{draft.counts[key]}</b>
        <button type="button" aria-label={`${label}增加`} disabled={draft.counts[key] >= max} onClick={() => setCount(key, draft.counts[key] + 1)}>+</button></span></span>))}
      <small className="lp-muted">3:4 照着 1:1 出，不能比 1:1 多</small></div>
    <h4 className="lp-h">出几套 <small>想用不同颜色做不同链接，就加一套首图</small></h4>
    <div className="lp-sets">
      <div className="lp-set main"><b>主推套 · {draft.main}</b><span>1:1 {draft.counts.square} 张 + 3:4 {draft.counts.portrait} 张 + 长图 {draft.counts.long} 张，另有每色白底图和 SKU 图</span></div>
      {draft.extra.map((e, k) => (
        <div key={k} className="lp-set"><b>加一套首图</b>
          颜色 <select value={e.color} onChange={x => set({ extra: draft.extra.map((y, m) => m === k ? { ...y, color: x.target.value } : y) })}>{ok.filter(c => c.name === e.color || free.includes(c)).map(c => <option key={c.name}>{c.name}</option>)}</select>
          版式 <select value={e.layout} onChange={x => set({ extra: draft.extra.map((y, m) => m === k ? { ...y, layout: x.target.value } : y) })}><option value="">跟主推套一样</option>{layouts.filter(l => l.id !== draft.layout).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <span className="grow">1:1 首图先出，3:4 首图和长图跟竖版一起出</span><button type="button" className="lp-btn link" onClick={() => set({ extra: draft.extra.filter((_, m) => m !== k) })}>不要了</button></div>))}
      {free.length > 0 && <div><button type="button" className="lp-btn sm" onClick={() => set({ extra: [...draft.extra, { color: free[0].name, layout: "" }] })}>＋ 再加一套首图（换个颜色）</button></div>}
    </div>
  </>);

  /** Step 3 changes also bring in close-ups of parts the material has (a cell now showing 袖口 finds M43). */
  const change = (d: Draft) => onChange(fillParts(d, materials.sorted.images));
  /* ③ 卖点上图: the points (left) and the images (right) */
  const placeMenu = (p: Point) => {
    const all = placesFor(draft, p.id, layout), list = placing?.all ? all : all.slice(0, 3);
    return (<div className="lp-place">{list.length ? list.map(x => <button type="button" key={x.label} className={"lp-btn sm" + (x.mine && x.empty ? " primary" : "")} onClick={() => { change(x.apply(draft)); setPlacing(null); }}>{x.label}</button>)
      : <span className="lp-muted">每张图都放满了，没有空位</span>}
      {!placing?.all && all.length > 3 && <button type="button" className="lp-btn link" onClick={() => setPlacing({ id: p.id, all: true })}>更多位置（{all.length - 3}）</button>}
      <button type="button" className="lp-btn sm ghost" onClick={() => setPlacing(null)}>取消</button></div>);
  };
  const pointRow = (p: Point) => {
    const where = usage.get(p.id) ?? [], extra = p.source === "品类", tooLong = len(p.text) > LIMITS.cell && where.some(w => /格|标签/.test(w));
    return (
      <div key={p.id} id={`lp-pt-${p.id}`} className={"lp-pp" + (p.on ? "" : " off")}>
        <label className="use"><input type="checkbox" checked={p.on} disabled={p.type === "定位"} onChange={e => change(tickPoint(draft, p.id, e.target.checked, layout))} />{extra ? (p.kind === "服务" ? "我们提供" : "衣服有") : "用"}</label>
        <div className="body">
          <input className="big" value={p.text} maxLength={LIMITS.title} aria-label="卖点" onChange={e => change(renamePoint(draft, p.id, { text: e.target.value }))} />
          <div className="meta">
            {p.group !== "定位" && <span className={"lp-tag2 g" + p.group}>{GROUP_LABEL[p.group]}</span>}<span className="lp-tag2">{p.type}</span>
            {extra && <span className="lp-tag2 y">竞品常用说法，可改</span>}
            {p.seen && <span className={"lp-tag2 seen" + p.seen}>AI 看图：{SEEN_TEXT[p.seen]}</span>}
          </div>
          {[p.seenWhy, p.evidence, p.why].filter(Boolean).length > 0 && <small className="ev">{[p.seenWhy, p.evidence, p.why].filter(Boolean).join("；")}</small>}
          {p.on && (where.length ? <small className="where">→ {where.join("、")}</small>
            : p.type !== "定位" && <small className="where none">没用上 <button type="button" className="lp-btn link" onClick={() => setPlacing(placing?.id === p.id ? null : { id: p.id, all: false })}>放到…</button></small>)}
          {tooLong && <small className="lp-warn">放在格子和标签里最多 {LIMITS.cell} 个字，删短一点</small>}
          {placing?.id === p.id && placeMenu(p)}
        </div>
      </div>);
  };
  const lead = draft.points.find(p => p.type === "定位");
  const own = draft.points.filter(p => p.source === "素材" && p.type !== "定位");
  const extras = draft.points.filter(p => p.source === "品类");
  const pool = (
    <div className="lp-pool">
      <div className="lp-cat">按「<b>{category.name}</b>」来排{draft.categoryWhy && <>：{draft.categoryWhy}</>}
        <button type="button" className="lp-btn link" onClick={() => { if (window.confirm(`改成按「${draft.category === "generic" ? "团体工作服定制" : "通用"}」来排？卖点和每张图都会重新排。`)) change(startDraft(materials, layout, draft.counts, draft.category === "generic" ? "workwear" : "generic")); }}>{draft.category === "generic" ? "改回工作服" : "不对？按通用来排"}</button>
        {category.source && <small>竞品数据：{category.source}</small>}</div>
      {lead && <><h4 className="lp-h">定位 <small>首图大标题，一句话说清这是什么衣服</small></h4>{pointRow(lead)}</>}
      <h4 className="lp-h">你素材里的卖点 <small>按重要程度排：你多强调 + 竞品多看重</small></h4>
      <div className="lp-pts">{own.map(pointRow)}</div>
      {extras.length > 0 && <>
        <h4 className="lp-h">竞品常讲、你没写的 <small>{GROUP_HINT.补充}。勾上才会用</small></h4>
        {extras.some(p => p.kind === "衣服" && !p.folded) && <><p className="lp-sub2">衣服功能：衣服真有才勾。AI 看过你的衣服图，给了判断</p><div className="lp-pts">{extras.filter(p => p.kind === "衣服" && !p.folded).map(pointRow)}</div></>}
        {extras.some(p => p.kind === "服务" && !p.folded) && <><p className="lp-sub2">服务：看图看不出来，你们提供才勾</p><div className="lp-pts">{extras.filter(p => p.kind === "服务" && !p.folded).map(pointRow)}</div></>}
        {extras.some(p => p.folded) && <details className="lp-more"><summary>还有 {extras.filter(p => p.folded).length} 条（排得靠后，或看着不像有）</summary><div className="lp-pts">{extras.filter(p => p.folded).map(pointRow)}</div></details>}
      </>}
    </div>);

  const imageCard = (i: number) => {
    const setSlot = (_: number, patch: Partial<Slot>) => change({ ...draft, slots: draft.slots.map((x, m) => m === i ? { ...x, ...patch } : x) });
    const hl = (zones: string[]) => ({ onMouseEnter: () => setHover({ slot: i, zones }), onMouseLeave: () => setHover(null), onFocus: () => setHover({ slot: i, zones }), onBlur: () => setHover(null) });
    const s = draft.slots[i], k = used.indexOf(i), base = layout.templates[s.task].square, room = capacity(base), t = templateFor(layout, s), notes = notesOf(draft, i, layout);
    const leadPoint = pointOf(s.lead), acts = leadPoint && room.person ? proofsFor(leadPoint, category).filter(p => p.person) : [];
    // What the preview writes in each zone: the words, each card's point and way of drawing, the models' demonstration.
    const zoneIds = (kind: string) => t.zones.filter(z => z.kind === kind).map(z => z.id);
    const act = proofById(s.act ?? "");
    const texts: Record<string, { text: string; note?: string }> = {
      ...Object.fromEntries(zoneIds("title").map(id => [id, { text: s.title }])),
      ...Object.fromEntries(zoneIds("sub").map(id => [id, { text: s.sub, note: s.sub ? undefined : "小字（空）" }])),
      ...Object.fromEntries(zoneIds("tag").map((id, n) => [id, { text: s.tags[n] ?? "", note: s.tags[n] ? "标签" : "标签（空）" }])),
      ...Object.fromEntries(cellZones(t).map((z, n) => { const c = s.cells[n]; return [z.id, { text: pointOf(c?.point)?.text ?? "", note: proofById(c?.proof ?? "")?.name }]; })),
      ...Object.fromEntries(zoneIds("person").map(id => [id, { text: `模特 · ${PEOPLE_LABEL(t)}`, note: act ? `演示：${act.name}` : undefined }])),
      ...Object.fromEntries(zoneIds("garment").map(id => [id, { text: `衣服${t.display ?? ""}` }])),
      ...Object.fromEntries(zoneIds("swatch").map(id => [id, { text: s.colors.join(" · ") || "色块" }])),
    };
    const active = hover?.slot === i ? hover.zones : [];
    const missing = missingParts(draft, s);
    const inImage = new Set([...s.cells.map(c => c.point), ...s.tags.map(x => draft.points.find(p => p.text === x)?.id)]);
    const choices = on.filter(p => !inImage.has(p.id));
    const titles = [...new Set([...(draft.titles[s.task] ?? []), ...(leadPoint ? [leadPoint.text] : [])])].filter(x => x !== s.title);
    const setCell = (n: number, pointId: string) => { const p = pointOf(pointId); if (p) setSlot(i, { cells: s.cells.map((c, m) => m === n ? { point: p.id, proof: fitProof(p, base, category) } : c) }); };
    return (
      <div key={i} id={`lp-img-${i}`} className={"lp-slot" + (notes.length ? " warn" : "") + (k < 0 ? " off" : "")}>
        <div className="who"><b>{k < 0 ? "这张不出" : `第 ${k + 1} 张`}</b><span>{TASK_LABEL[s.task]}</span><small>{k < 0 ? `1:1 只出 ${draft.counts.square} 张，留讲得最多的` : TASK_HINT[s.task]}</small>
          {s.shopService ? <KeptPreview value={s.shopService} width={220} /> : <SlotPreview template={t} texts={texts} active={active} width={220} />}<small className="ppl">右边鼠标移到哪一项，这里对应的位置会亮</small></div>
        <div className={"lp-fields" + (s.shopService ? " kept" : "")}>
          {s.task === "服务" && <ServicePick value={s.shopService ?? ""} onChange={v => setSlot(i, { shopService: v || undefined })} onOpen={onService} />}
          <label>大标题</label><div className="lp-title" {...hl(zoneIds("title"))}><input className="big" value={s.title} maxLength={LIMITS.title} onChange={e => setSlot(i, { title: e.target.value })} />
            {s.task !== "首图" && titles.length > 0 && <select value="" aria-label="换一句" onChange={e => e.target.value && setSlot(i, { title: e.target.value })}><option value="">换一句…</option>{titles.map(x => <option key={x}>{x}</option>)}</select>}</div>
          {room.sub && <><label>小字</label><input {...hl(zoneIds("sub"))} value={s.sub} maxLength={LIMITS.sub} placeholder={i === 0 ? "首图可以不写小字" : "一句说明，可空"} onChange={e => setSlot(i, { sub: e.target.value })} /></>}
          {acts.length > 0 && <><label>模特演示</label><select {...hl(zoneIds("person"))} value={s.act ?? ""} onChange={e => setSlot(i, { act: e.target.value || null })}><option value="">只穿着，不演示</option>{acts.map(a => <option key={a.id} value={a.id}>{leadPoint!.text}：{a.name}</option>)}</select></>}
          {s.cells.map((c, n) => {
            const p = pointOf(c.point), proofs = p ? proofsFor(p, category).filter(x => !x.person || base.people > 0) : [], proof = proofById(c.proof);
            return (<div key={n} className="lp-row-c">
              <label>{cellZones(t)[n]?.kind === "icon" ? `图标 ${n + 1}` : `格 ${n + 1}`}<small>{cellZones(t)[n]?.kind === "icon" ? "图标加一句" : "配一个画面"}</small></label>
              <div className="lp-cell" {...hl([cellZones(t)[n]?.id ?? ""])}>
                <select value={c.point} onChange={e => setCell(n, e.target.value)}>{[p, ...choices].filter((x): x is Point => !!x).map(x => <option key={x.id} value={x.id}>{x.text}</option>)}</select>
                <select value={c.proof} onChange={e => setSlot(i, { cells: s.cells.map((x, m) => m === n ? { ...x, proof: e.target.value } : x) })}>{proofs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                <button type="button" className="lp-btn sm ghost" aria-label="去掉这格" title="去掉这格，其余的格子会变大" onClick={() => setSlot(i, { cells: s.cells.filter((_, m) => m !== n) })}>✕</button>
                {proof && <small className="lp-muted" title={proof.recipe}>画面：{proof.recipe.replace("{part}", p?.part || p?.text || "")}</small>}
              </div></div>);
          })}
          {s.task !== "首图" && room.cells > s.cells.length && choices.length > 0 && <><span /><select className="lp-add" value="" onChange={e => { const p = pointOf(e.target.value); if (p) setSlot(i, { cells: [...s.cells, { point: p.id, proof: fitProof(p, base, category) }] }); }}>
            <option value="">＋ 加一格（还能加 {room.cells - s.cells.length} 格）</option>{choices.map(p => <option key={p.id} value={p.id}>{p.text}</option>)}</select></>}
          {room.tags > 0 && <><label>标签<small>小胶囊字</small></label><div className="lp-chips" {...hl(zoneIds("tag"))}>{s.tags.map((tg, n) => <span key={n} className="lp-tagx">{tg}<button type="button" aria-label="去掉" onClick={() => setSlot(i, { tags: s.tags.filter((_, m) => m !== n) })}>×</button></span>)}
            {s.tags.length < room.tags && <select value="" onChange={e => e.target.value && setSlot(i, { tags: [...s.tags, e.target.value] })}><option value="">＋ 加标签</option>{choices.map(p => <option key={p.id} value={p.text}>{p.text}</option>)}</select>}
            <small className="lp-muted">图上的小胶囊字（预览里绿色的小块），补一句卖点，不配画面；最多 {room.tags} 个</small></div></>}
          {showsGarment(layout, s.task) && <><label>颜色<small>衣服穿哪个色</small></label><div className="lp-chips" {...hl([...zoneIds("person"), ...zoneIds("garment")])}>{ok.map(c => (
            <button type="button" key={c.name} className={"lp-chip" + (s.colors.includes(c.name) ? " on" : "")} disabled={i === 0} onClick={() => pickColor(i, c.name)}><span className="dotc" style={{ background: c.hex || "#999" }} />{c.name}</button>))}
            <small className="lp-muted">{i === 0 ? "首图跟主推色，在第 ① 步改" : `${i === draft.slots.length - 1 ? "多选，最多 4 个" : "单选"} · ${s.why ?? ""}`}</small>
            {s.manual && <button type="button" className="lp-btn link" onClick={() => change({ ...draft, slots: colorize(draft, layout, draft.slots.map((x, m) => m === i ? { ...x, manual: false } : x)) })}>按规则重排</button>}</div></>}
          {missing.map(({ n, p }) => {
            const alt = proofsFor(p, category).find(x => !x.part && !x.person) ?? proofById("icon-text")!;
            return (<div key={"m" + n} className="lp-fix"><b>格 {n + 1}「{p.text}」要拍{partOf(p)}特写，可素材里没有{partOf(p)}的照片</b>（AI 在全部素材里找过了）。
              <span><button type="button" className="lp-btn sm" onClick={() => setSlot(i, { cells: s.cells.map((x, m) => m === n ? { ...x, proof: alt.id } : x) })}>改成「{alt.name}」</button>
                <button type="button" className="lp-btn sm" onClick={() => { onChange({ ...draft, parts: [...draft.parts, { part: partOf(p), pick: null }] }); setStep(1); setTab("全部"); setTarget({ kind: "part", index: draft.parts.length }); }}>补一张{partOf(p)}的照片</button>
                <button type="button" className="lp-btn sm ghost" onClick={() => setSlot(i, { cells: s.cells.filter((_, m) => m !== n) })}>这格不要了</button></span></div>);
          })}
          {notes.filter(x => !missing.some(m => x.includes(`「${m.p.text}」要拍`))).map(x => <p key={x} className="lp-warn lp-note">! {x}</p>)}
        </div>
      </div>);
  };
  const table = (r: { lines: PriceLine[]; images: number; credits: number }) => <table className="lp-ptable"><tbody>{r.lines.map((l, i) => <tr key={i}><td>{l.label}{l.note && <small> {l.note}</small>}</td><td>{l.count} 张</td><td>× {l.unit}</td><td>{l.unit ? l.credits : "免费"}</td></tr>)}
    <tr className="total"><td>合计</td><td>{r.images} 张</td><td /><td>约 {r.credits} 积分</td></tr></tbody></table>;
  const images = (
    <div className="lp-images">
      <p className="lp-say">每张图的格子来自上一步的版式「<b>{layout.name}</b>」，<b>几张图讲什么、每张几格，跟着左边勾的卖点走</b>：服务卖点到 3 条才单独出服务说明图，卖点不够时出一张场景图。格子里的字就是左边的卖点，改字去左边改；大标题是 AI 写的一句，可以换、可以改。<b>这里的字就是印到图上的字。</b></p>
      <ServiceBar slots={draft.slots} onSlots={slots => change({ ...draft, slots })} onOpen={onService} />
      {hint && <div className="lp-alert y lp-hint">按现在勾的卖点，可以{hint}。<button type="button" className="lp-btn sm" onClick={() => { if (window.confirm("按现在勾的卖点重排每张图？右边改过的标题和格子会重新排，颜色你选过的保留。")) change(replan(draft, layout)); }}>按新卖点重排每张图</button></div>}
      <div className="lp-slots">{draft.slots.map((_, i) => imageCard(i))}</div>
      {draft.counts.long > 0 && <>
        <h4 className="lp-h">2:3 长图 <small>手淘推荐流里的竖版长图：人物完整、只有一行字，不放标签和格子</small></h4>
        <div className="lp-slot"><div className="who"><b>长图</b><Wire template={layout.long} ratio={2 / 3} width={84} /><small className="ppl">{PEOPLE_LABEL(layout.long)}</small></div><div className="lp-fields">
          <label>一行字</label><input className="big" value={draft.long.title} maxLength={LIMITS.title} onChange={e => change({ ...draft, long: { title: e.target.value } })} /></div></div></>}
      {!prices.exempt && <><h4 className="lp-h">费用 <small>分两次扣：开始出图扣第一次；方图满意后点「出竖版」再扣第二次</small></h4>
        <div className="lp-two"><div><b>现在：开始出图</b>{table(cost.now)}</div><div><b>以后：出竖版</b>{cost.later.images ? table(cost.later) : <p className="lp-muted">不出竖版</p>}</div></div></>}
    </div>);
  const mapStep = <div className="lp-map">{pool}{images}</div>;

  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan wide" role="dialog" aria-modal="true" aria-label="定方案">
        <div className="lp-box-head"><div><h3>定方案 · {name}</h3><p className="lp-sub">AI 已经整理好素材，下面每一项都是它的建议，不对的直接改。点「开始出图」之前不花钱。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-stepbar">{STEPS.map((s, i) => <button type="button" key={s} className={step === i + 1 ? "on" : i === 0 && check.red.length ? "bad" : i === 2 && check.warn.length ? "warn" : "ok"} onClick={() => go(i + 1)}>{s}</button>)}</div>
        <div className={"lp-box-body" + (step === 3 ? " map" : "")} key={step}>{step === 1 ? step1 : step === 2 ? layoutStep : mapStep}</div>
        <div className="lp-box-foot">
          <div className="grow">{check.red.length ? <span className="lp-bad">{check.red[0]}</span> : <>现在出 {cost.now.images} 张（白底图、{cast ? "定妆照、" : ""}SKU 图、1:1 主图）{!prices.exempt && <>，约 <b>{cost.now.credits}</b> 积分 <PriceInfo lines={cost.now.lines} total={cost.now.credits} extra="分析费已在整理时扣过" /></>}
            {cost.later.images > 0 && <span className="lp-muted"> · 竖版 {cost.later.images} 张以后再出{!prices.exempt && `，约 ${cost.later.credits} 积分`}</span>}
            {check.warn.length > 0 && <span className="lp-warn"> · 有提醒：{check.warn.map(k => <button type="button" key={k} className="lp-btn link" onClick={() => jump(k)}>第 {k} 张</button>)}</span>}</>}</div>
          {step > 1 && <button type="button" className="lp-btn" onClick={() => go(step - 1)}>上一步</button>}
          {step < 3 ? <button type="button" className="lp-btn primary" disabled={check.red.length > 0} onClick={() => go(step + 1)}>下一步</button>
            : <button type="button" className="lp-btn primary" disabled={busy || check.red.length > 0} onClick={async () => { setBusy(true); try { await onStart(); } finally { setBusy(false); } }}>{busy ? "正在开始…" : `开始出图${prices.exempt ? "" : ` · 约 ${cost.now.credits} 积分`}`}</button>}
        </div>
      </div>

      {target && (
        <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) setTarget(null); }}>
          <div className="lp-box" role="dialog" aria-modal="true" aria-label="选一张图">
            <div className="lp-box-head"><div><h3>{target.kind === "color" ? `选「${draft.colors[target.index].name}」的衣服图` : `选结构图「${draft.parts[target.index]?.part ?? ""}」`}</h3>
              <p className="lp-sub">{target.kind === "color" ? "要衣服完整、正面、颜色准。推荐里是 AI 认为是这个颜色的图。" : draft.parts[target.index]?.part === FRONT ? "衣服完整的正面图" : `「${draft.parts[target.index]?.part ?? ""}」的特写，挑最清楚的一张；名字不对可以在外面改`}</p></div>
              <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={() => setTarget(null)}>关闭</button></div>
            <div className="lp-box-body">
              <div className="lp-tabs">{["推荐", "全部", ...KINDS].map(k => <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}</div>
              <div className="lp-lib">{shown.length ? shown.map(i => (
                <button type="button" key={i.label} className="it" onClick={() => assign(i.label)}><img src={i.url} alt="" loading="lazy" /><span className="cat">{sorted.get(i.label)?.kind}{sorted.get(i.label)?.color ? "·" + sorted.get(i.label)!.color : ""}</span><small>{i.path}</small></button>))
                : <span className="lp-muted">素材里没有推荐的图，可以看「全部」或补传一张。</span>}</div>
            </div>
            <div className="lp-box-foot"><div className="grow">{target.kind === "part" && draft.parts[target.index]?.part !== FRONT
              ? <button type="button" className="lp-btn link" onClick={() => { set({ parts: draft.parts.filter((_, k) => k !== target.index) }); setTarget(null); }}>不要这个部位（出图时不做特写）</button> : "素材里没有合适的？"}</div>
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
