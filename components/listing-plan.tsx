"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图「定方案」, four steps: ① this product — its category, each colour's garment image, what the
 * chest shows; ② the master (母版), where its cover is shot when it is shot on location, the model
 * and the counts; ③ 卖点上图 — the points on the left and the images on the right, the cover's point
 * acted out in its picture; ④ what is made and what it costs. A point's words are kept in one place,
 * the list; the images use them. Nothing is paid before 「开始出图」.
 */
import { useEffect, useRef, useState } from "react";
import type { LayoutCard, Materials, Source } from "@/lib/listing/api-types";
import { assetUrl } from "@/lib/listing/client-api";
import { CATEGORIES, categoryById, GROUP_HINT, GROUP_LABEL, TASK_HINT, TASK_LABEL } from "@/lib/listing/category";
import {
  checkDraft, CLOSER_MAX, colorize, colorKeys, defaultDraft, directKeys, draftImages, FRONT, LIMITS, notesOf, placesFor, priceLines, proofsFor, renamePoint, replan, showsGarment, structureHint, sumCredits, syncCloser,
  templateFor, takeOff, putOn, usageOf, usedSlots, fitProof, fillParts, fillModel, modelPhotos, castFromPhotos, GENDERS, missingParts, partOf, wantsCast, hasPart, noPhotoProof, reusedSlots,
  SKU_PEOPLE, type Counts, type Draft, type Gender, type Point, type PriceLine, type Slot,
} from "@/lib/listing/draft";
import { isComponent, isGroup } from "@/lib/listing/garment-role";
import { proofById } from "@/lib/listing/proofs";
import { auditDraft, type AuditFix } from "@/lib/listing/audit";
import { skuPhotos, skuWho } from "@/lib/listing/sku-card";
import { capacity, cellZones, mostCells, PEOPLE_LABEL, skuPair, type Layout } from "@/lib/listing/templates";
import { SlotPreview, Wire } from "./listing-wire";
import { bestSell, coverPicks, coverScene, isSellTitle, masterInfo, PLACE_IDS, PLACES, seedOf, SELLS, sellOf, sellTitle, type PlaceId, type Sell } from "@/lib/listing/scene";
import { useShopService } from "./listing-service";

export const KINDS = ["颜色款图", "静物", "3D渲染", "模特实拍", "细节特写", "卖点图", "详情页", "海报", "尺码表", "无关"] as const;
export type Prices = { image: number; multi: number; exempt: boolean };

const live = (d: Draft) => d.colors.filter(c => c.pick);
/** The colours (by image label) the material has its own model photo of, for their SKU images. */
const photosOf = (d: Draft, m: Materials, layout: Layout) => new Set(Object.keys(skuPhotos({ colors: live(d), model: d.model, skuPeople: d.skuPeople }, m.sorted.images, skuPair(layout))));
const len = (s: string) => [...s.trim()].length;
export const layoutOf = (layouts: LayoutCard[], id: string): Layout => layouts.find(l => l.id === id) ?? layouts[0];

/** The AI's plan as the starting point; `category` overrides the AI's call. */
export function startDraft(m: Materials, layout: Layout, counts?: Counts, category = m.category): Draft {
  const d = fillModel(fillParts(defaultDraft({ category, categoryWhy: m.categoryWhy, checks: m.checks, titles: m.titles, points: m.sorted.points, colors: m.chosen.colors, parts: m.chosen.parts }, layout, counts), m.sorted.images), m.sorted.images);
  return lookScene(m.variant ? { ...d, seed: m.variant } : d, layout, m.look);
}
/** The master the AI picked from the material; an unknown one (or none, on older material) falls back to `fallback`. */
export const lookMaster = (m: Materials, fallback: string) => m.look?.master ?? fallback;
/** The cover shot where the AI said, acting out its point when the place can; otherwise the rules in withScene. */
function lookScene(d: Draft, layout: Layout, look: Materials["look"]): Draft {
  const info = masterInfo(layout.id), place = look?.place;
  if (info.cover !== "实景" || !place || info.deny[place]) return withScene(d, layout);
  // The AI's point is one of those taken in turn, so fifty jackets do not all lead with 防水 (10-17).
  const first = look.sell && (PLACES[place].fits as readonly Sell[]).includes(look.sell) ? look.sell : undefined;
  const sell = bestSell(place, ticked(d), planSeed(d), first) ?? "防水";
  return sellWords({ ...d, scene: sceneAt(d, place, sell) }, sell);
}
/** Where each on-location master shoots its cover when the AI did not say. */
const DEFAULT_PLACE: Record<string, PlaceId> = { M1: "4S店", M2: "物业", M3: "工地" };
const ticked = (d: Draft) => d.points.filter(p => p.on).map(p => p.text);
/**
 * The plan's seed: its product (the material's points and colours), so one product keeps its picks and
 * the next differs; a copy's number (「再出一套」) is added, so the copies take the points in turn.
 */
const planSeed = (d: Draft) => (seedOf([d.category, ...d.points.filter(p => p.source === "素材").map(p => p.text), ...d.colors.map(c => c.name)].join("|")) + (d.seed ?? 0)) >>> 0;
/** The cover's scene with its act and look picked by the seed. */
const sceneAt = (d: Draft, place: string, sell: string) => ({ place, sell, ...coverPicks(planSeed(d), place, sell) });
/** The cover's big words follow its point, one of its words by the seed: 防水 → 「拒水」「团体定制」. */
const sellWords = (d: Draft, sell: Sell): Draft => { const w = sellTitle(sell, planSeed(d)); return { ...d, slots: d.slots.map((x, i) => i === 0 ? { ...x, title: w.title, sub: w.sub } : x) }; };
/**
 * A master whose cover is shot on location keeps a place it can use (or its default) and a point:
 * the one chosen if the place can act it out, else the ticked point that fits the place best. Other
 * masters keep no scene.
 */
export function withScene(d: Draft, layout: Layout): Draft {
  const info = masterInfo(layout.id);
  if (info.cover !== "实景") return d.scene ? { ...d, scene: undefined } : d;
  const keep = d.scene && d.scene.place in PLACES && !info.deny[d.scene.place as PlaceId] ? d.scene.place as PlaceId : undefined;
  const place = keep ?? (DEFAULT_PLACE[layout.id] && !info.deny[DEFAULT_PLACE[layout.id]] ? DEFAULT_PLACE[layout.id] : PLACE_IDS.find(p => !info.deny[p])!);
  const had = d.scene?.sell && d.scene.sell in SELLS ? d.scene.sell as Sell : null;
  // A place chosen on the page comes without picks: it takes the seed's.
  if (keep && had) return d.scene!.act === undefined ? { ...d, scene: sceneAt(d, keep, had) } : d;
  const fits = had && (PLACES[place].fits as readonly Sell[]).includes(had);
  const sell = fits ? had : bestSell(place, ticked(d), planSeed(d)) ?? had ?? "防水";
  const next = { ...d, scene: sceneAt(d, place, sell) };
  return sell === had ? next : sellWords(next, sell);
}
/** The cover's title was written by hand: neither a point's cover word nor the point the cover leads with. */
const handWritten = (d: Draft) => {
  const t = d.slots[0]?.title.trim() ?? "", lead = d.points.find(p => p.id === d.slots[0]?.lead)?.text.trim();
  return !!t && t !== lead && !isSellTitle(t);
};
/**
 * Lay the images out again on a master, as if the plan had started on it: the images, the place
 * (kept when the master can shoot there), the cover's point and its words. With `keepHand` the
 * cover's words the user wrote stay.
 */
export function rearrange(d: Draft, layout: Layout, keepHand: boolean): Draft {
  const next = withScene(replan(d, layout), layout), cover = d.slots[0];
  if (keepHand && handWritten(d)) return { ...next, slots: next.slots.map((s, i) => i === 0 ? { ...s, title: cover.title, sub: cover.sub } : s) };
  return next.scene ? sellWords(next, next.scene.sell as Sell) : next;
}
/** Another category: its points and images afresh; the colours, parts, chest, model and counts the user set stay. */
function withCategory(d: Draft, m: Materials, layout: Layout, category: string): Draft {
  const fresh = startDraft(m, layout, d.counts, category);
  return rearrange({ ...fresh, colors: d.colors, main: d.main, parts: d.parts, logo: d.logo, model: d.model, skuPeople: d.skuPeople, extra: d.extra, scene: d.scene }, layout, false);
}
/** What changed on the cover when the master could not shoot where it was, said once. */
function movedNote(before: Draft, after: Draft, layout: Layout): string {
  const from = before.scene?.place as PlaceId | undefined, to = after.scene?.place as PlaceId | undefined;
  if (!from || !to || from === to || !(from in PLACES)) return "";
  const why = masterInfo(layout.id).deny[from], name = layout.name.split(" · ")[0];
  const sell = after.scene!.sell !== before.scene!.sell ? `；${PLACES[to].name}演不了「${before.scene!.sell}」，首图卖点换成「${after.scene!.sell}」` : "";
  return `${name}不能在${PLACES[from].name}拍${why ? `（${why}）` : ""}，已改成${PLACES[to].name}${sell}`;
}
/** After the colours changed: the closer's count, the colours of every image and the extra sets follow. */
function recolor(d: Draft, layout: Layout): Draft {
  const ok = live(d), names = ok.map(c => c.name), main = names.includes(d.main) ? d.main : names[0] ?? "";
  const next = { ...d, main, extra: d.extra.filter(e => names.includes(e.color) && e.color !== main) };
  return { ...next, slots: colorize(next, layout, d.slots.map((s, i) => i === d.slots.length - 1 ? syncCloser(s, names) : s)) };
}

/** The two rounds' images and credits: round one at 「开始出图」, round two at 「出竖版」. */
export function draftPrice(d: Draft, m: Materials, layout: Layout, prices: Prices) {
  const direct = new Set(directKeys(d.colors, m.sorted.images));
  const items = draftImages(d, layout, direct, photosOf(d, m, layout), reusedSlots(d, m.reuse));
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

const STEPS = ["① 确认这款", "② 选母版", "③ 卖点上图", "④ 确认出图"];
/** What the picker fills: a colour's garment image, a structure image, or the man's (0) or woman's (1) model photo. */
type Target = { kind: "color" | "part" | "model"; index: number } | null;
const SEEN_TEXT = { 有: "看得出有", 看不出: "看图看不出", 不像: "看着不像有" } as const;

export function PlanDialog({ name, materials, sources, draft, layouts, prices, onChange, onUpload, onService, onClose, onStart }: {
  name: string; materials: Materials; sources: Source[]; draft: Draft; layouts: LayoutCard[]; prices: Prices;
  onChange: (d: Draft) => void; onUpload: (file: File) => Promise<{ label: string }>; onService: () => void; onClose: () => void; onStart: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [target, setTarget] = useState<Target>(null);
  const [tab, setTab] = useState("推荐");
  const [libTab, setLibTab] = useState("全部");
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<{ id: string; all: boolean } | null>(null);
  const [hover, setHover] = useState<{ slot: number; zones: string[] } | null>(null);
  const [moved, setMoved] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const logoUpload = useRef<HTMLInputElement>(null);
  const shop = useShopService();
  const layout = layoutOf(layouts, draft.layout), category = categoryById(draft.category);
  const sorted = new Map(materials.sorted.images.map(i => [i.id, i]));
  const byLabel = new Map(materials.images.map(i => [i.label, { label: i.label, url: assetUrl(i.assetId), path: sources.find(s => s.id === i.assetId)?.path ?? i.label }]));
  const copies = [...materials.duplicates.map(([copy, keep]) => ({ copy, keep })), ...materials.sorted.images.filter(i => i.same).map(i => ({ copy: i.id, keep: i.same }))];
  const library = [...byLabel.values()].filter(i => !copies.some(c => c.copy === i.label));
  const check = checkDraft(draft, layout, materials.sorted.images), cost = draftPrice(draft, materials, layout, prices), ok = live(draft);
  const used = usedSlots(draft, draft.counts.square), usage = usageOf(draft), hint = structureHint(draft, layout);
  const pointOf = (id: string | null | undefined) => draft.points.find(p => p.id === id);
  const on = draft.points.filter(p => p.on && p.type !== "定位");
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const kindOf = (label: string | null) => (label && (isComponent(sorted.get(label)) ? sorted.get(label)?.role || "内胆" : isGroup(sorted.get(label)) ? "合照" : sorted.get(label)?.kind)) || "补传";
  const candidates = (t: NonNullable<Target>) => {
    if (t.kind === "color") {
      const c = draft.colors[t.index], chosen = materials.chosen.colors.find(x => x.name === c.name)?.candidates ?? [];
      return library.filter(i => !isComponent(sorted.get(i.label)) && (chosen.includes(i.label) || sorted.get(i.label)?.color === c.name));
    }
    if (t.kind === "model") {
      const known = materials.sorted.images.some(i => i.person !== undefined), fit = known ? modelPhotos(materials.sorted.images, GENDERS[t.index]) : materials.sorted.images.filter(i => i.kind === "模特实拍" && !i.same);
      return fit.map(i => byLabel.get(i.id)).filter((i): i is NonNullable<typeof i> => !!i);
    }
    const part = draft.parts[t.index]?.part ?? "", chosen = materials.chosen.parts.find(x => x.part === part)?.candidates ?? [];
    return library.filter(i => chosen.includes(i.label) || (part !== FRONT && sorted.get(i.label)?.kind === "细节特写"));
  };
  const assign = (label: string) => {
    if (!target) return;
    if (target.kind === "model") set({ model: { ...draft.model, photos: { ...draft.model.photos, [GENDERS[target.index]]: label } } });
    else if (target.kind === "color") onChange(recolor({ ...draft, colors: draft.colors.map((c, k) => k === target.index ? { ...c, pick: label } : c) }, layout));
    else set({ parts: draft.parts.map((p, k) => k === target.index ? { ...p, pick: label } : p) });
    setTarget(null);
  };
  const shown = target ? (tab === "推荐" ? candidates(target) : library.filter(i => tab === "全部" || sorted.get(i.label)?.kind === tab)) : [];
  const pic = (label: string | null) => label && byLabel.get(label) ? <img src={byLabel.get(label)!.url} alt="" loading="lazy" /> : null;
  const go = (n: number) => { if (n > step) { const d = withScene(draft, layout); if (d !== draft) onChange(d); } setStep(check.red.length && n > 1 ? 1 : Math.max(1, Math.min(4, n))); };
  const pickColor = (i: number, c: string) => {
    const s = draft.slots[i], last = i === draft.slots.length - 1;
    const colors = last ? (s.colors.includes(c) ? s.colors.filter(x => x !== c) : [...s.colors, c].slice(0, CLOSER_MAX)) : [c];
    onChange({ ...draft, slots: colorize(draft, layout, draft.slots.map((x, k) => k === i ? { ...x, colors: colors.length ? colors : [c], manual: true } : x)) });
  };
  const jump = (k: number) => { setStep(3); setTimeout(() => document.getElementById(`lp-img-${used[k - 1]}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };

  const audit = auditDraft(draft, materials, name);
  const fixAudit = (f: AuditFix) => {
    if (f.kind === "category") onChange(withCategory(draft, materials, layout, f.to));
    else if (f.kind === "part") onChange({ ...draft, parts: [...draft.parts.filter(x => x.part !== f.part), { part: f.part, pick: f.pick }] });
    else { const at = draft.parts.findIndex(x => x.part === f.part); if (at < 0) onChange({ ...draft, parts: [...draft.parts, { part: f.part, pick: null }] }); setTab("全部"); setTarget({ kind: "part", index: at < 0 ? draft.parts.length : at }); }
  };
  const logoMode = draft.logo?.mode ?? "LOGO";
  // A shop with a sample LOGO prints it on the chest unless the plan says otherwise (10-21).
  useEffect(() => { if (!draft.logo && shop?.logo) onChange({ ...draft, logo: { mode: "样例" } }); }, [draft, shop?.logo, onChange]);
  const step1 = (<>
    <div className="lp-catcard"><b>品类</b>
      <span className="lp-chips">{CATEGORIES.map(c => (
        <button type="button" key={c.id} className={"lp-chip" + (c.id === draft.category ? " on" : "")} onClick={() => c.id !== draft.category && onChange(withCategory(draft, materials, layout, c.id))}>
          {c.id === "workwear" ? "冲锋衣" : "其他衣服"}{c.id === materials.category && <small className="lp-muted">AI 判断</small>}</button>))}</span>
      <span className="why">{draft.category === materials.category ? draft.categoryWhy || "按衣服的样子判断：连帽或立领、前中拉链、防风外套" : "你选的品类，卖点和每张图已按它重排"}</span>
      <small className="lp-muted">{category.id === "workwear" ? "冲锋衣：卖点按销量靠前的冲锋衣来排，还会补竞品常讲、素材没写的卖点" : "其他衣服：只用素材里的卖点，不参考竞品"} · 换品类会重排卖点和每张图，颜色和衣服图不动</small></div>
    <div className={"lp-alert " + (check.red.length ? "r" : "g")}>{check.red.length ? "✕ " + check.red.join("；") : "✓ 每个颜色都有衣服图，正面全身也有"}
      {materials.sorted.notes.length > 0 && <small>AI 的提醒：{materials.sorted.notes.join("；")}</small>}</div>
    {audit.length > 0 && <div className="lp-alert y lp-audit"><b>整理结果对不上的地方</b><small className="lp-muted">程序把 AI 的整理结果核了一遍，不影响往下走，看着不对就点改</small>
      {audit.map(a => <p key={a.text}>! {a.text}{a.fix && <> <button type="button" className="lp-btn sm" onClick={() => fixAudit(a.fix!)}>{a.fix.label}</button></>}</p>)}</div>}
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
            <button type="button" className="lp-btn link" onClick={() => set({ parts: draft.parts.filter((_, k) => k !== i) })}>移除</button></>}
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
    <h4 className="lp-h">胸口印什么 <small>竞品首图几乎都在胸口印了标；只影响有人和整件衣服的图</small></h4>
    <div className="lp-logo3">{([["样例", shop?.logo ? "店铺设置里的样例 LOGO，每款都能直接用" : "先去店铺设置传样例 LOGO"], ["客户", "这款单独传一个客户的 LOGO 做案例"], ["LOGO", "印一个「LOGO」字样，告诉买家能印标"], ["不印", "衣服原样，不印任何字"]] as const).map(([mode, what]) => (
      <button type="button" key={mode} disabled={mode === "样例" && !shop?.logo} className={"lp-pick" + (logoMode === mode ? " on" : "")} onClick={() => mode === "客户" && !draft.logo?.label ? logoUpload.current?.click() : set({ logo: { mode, label: draft.logo?.label } })}>
        <b>{mode === "不印" ? "不印" : mode === "LOGO" ? "印「LOGO」字样" : mode === "样例" ? "印样例 LOGO" : "印客户 LOGO"}</b>
        {mode === "样例" && shop?.logo && <img src={shop.logo} alt="样例 LOGO" />}
        <span>{mode === "客户" && draft.logo?.label ? `已上传 ${draft.logo.label}，点这里用它` : what}</span></button>))}
      <input ref={logoUpload} type="file" accept="image/*" hidden onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
        setBusy(true); try { const added = await onUpload(file); set({ logo: { mode: "客户", label: added.label } }); } catch { /* the page says why */ } finally { setBusy(false); }
      }} /></div>
    {logoMode === "客户" && <p className="lp-say">用真实客户的 LOGO 做案例，要确认是真实合作或已获授权。{draft.logo?.label && <button type="button" className="lp-btn link" onClick={() => logoUpload.current?.click()}>换一张</button>}</p>}
  </>);


  /* ② 版式、模特、张数 */
  const photos = photosOf(draft, materials, layout), cast = wantsCast(draft, layout, photos);
  const skuDrawn = layout.sku.specCard ? colorKeys(draft.colors).filter(k => k && !photos.has(k)).length : 0;
  /** The colours the material has its own model photo of, whatever the SKU images are set to show. */
  const skuReal = layout.sku.specCard ? photosOf({ ...draft, skuPeople: "实拍" }, materials, layout).size : 0;
  const skuBy = draft.skuPeople ?? "实拍", skuDrawnWho = (w: Gender | "男女") => w === "男女" ? "定妆照里的男女两位" : `定妆照里的${w === "男" ? "男生" : "女生"}`;
  const modelShots = materials.sorted.images.filter(i => i.kind === "模特实拍" && !i.same).length;
  /** Draw the cast from the material: the clearest man and woman picked, or none yet. */
  const pickModelPhotos = () => {
    const filled = fillModel({ ...draft, model: { lead: draft.model.lead } }, materials.sorted.images).model;
    set({ model: filled.photos ? filled : { lead: draft.model.lead, photos: {} } });
  };
  const free = ok.filter(c => c.name !== draft.main && !draft.extra.some(e => e.color === c.name));
  const setCount = (key: keyof Counts, n: number) => {
    const counts = { ...draft.counts, [key]: n };
    if (key === "square") counts.portrait = Math.min(counts.portrait, n);
    set({ counts });
  };
  const look = materials.look;
  const layoutStep = (<>
    {look && <p className="lp-say">AI 看了素材，建议用<b>{layouts.find(l => l.id === look.master)?.name ?? look.master}</b>{look.place ? `，首图在${PLACES[look.place].name}拍` : ""}{look.sell ? `，主打「${look.sell}」` : ""}。{look.why}{look.why && !/[。！？]$/.test(look.why) ? "。" : ""}不合适直接点别的。</p>}
    <div className="lp-masters">{layouts.filter(l => !l.own).map(l => {
      const info = masterInfo(l.id);
      return (
        <button type="button" key={l.id} className={"lp-master" + (l.id === draft.layout ? " on" : "")} onClick={() => { if (l.id === draft.layout) return; const next = rearrange(draft, l, true); onChange(next); setMoved(movedNote(draft, next, l)); }}>
          <span className="info"><b>{l.name}{look?.master === l.id && <span className="chip g">AI 建议</span>}</b><span>{l.description}</span><small>适合：{info.fit} · 字体：{info.font}</small>
            <span className={"chip" + (info.cover === "实景" ? " g" : "")}>{info.cover === "实景" ? "首图实景 · 要选在哪儿拍" : info.cover === "棚拍" ? "首图棚拍 · 不用选场景" : "首图无人 · 不用选场景"}</span></span>
          <span className="pics">{l.samples.map((src, i) => <span className="pic" key={src}><img src={src} alt="" loading="lazy" /><small>{["首图", "店铺服务图", "功能", "细节", "收口"][i]}</small></span>)}</span>
        </button>);
    })}</div>
    {masterInfo(layout.id).cover === "实景" ? <>
      <h4 className="lp-h">首图在哪儿拍 <small>只影响首图（和 2:3 长图）的背景；天气和动作跟着第 ③ 步的首图卖点（防水就下雨）</small></h4>
      {moved && <div className="lp-alert y">{moved}</div>}
      <div className="lp-places">{PLACE_IDS.map(id => {
        const deny = masterInfo(layout.id).deny[id], here = draft.scene?.place === id;
        return (<button type="button" key={id} disabled={!!deny} className={"lp-pick lp-place" + (here ? " on" : "")}
          onClick={() => { const sell = draft.scene?.sell, fits = !!sell && (PLACES[id].fits as readonly string[]).includes(sell); onChange(withScene({ ...draft, scene: { place: id, sell: fits ? sell! : "" } }, layout)); setMoved(""); }}>
          <img src={PLACES[id].image} alt="" loading="lazy" /><b>{PLACES[id].name}</b>{deny && <small>{deny}</small>}</button>);
      })}</div>
    </> : <p className="lp-say">这套母版的首图是{masterInfo(layout.id).cover}的，不用选在哪儿拍。</p>}
    <h4 className="lp-h">模特</h4>
    {cast ? <div className="lp-model">
      <div className="lp-chips"><span className="lp-muted lp-small">主模特</span>{(["男", "女"] as const).map(g => <label key={g} className={"lp-chip" + (draft.model.lead === g ? " on" : "")}><input type="radio" name="lead" hidden checked={draft.model.lead === g} onChange={() => set({ model: { ...draft.model, lead: g } })} />单人的图用{g === "男" ? "男生" : "女生"}</label>)}</div>
      <div className="lp-chips"><span className="lp-muted lp-small">长相</span>
        <label className={"lp-chip" + (!draft.model.photos ? " on" : "")}><input type="radio" name="faces" hidden checked={!draft.model.photos} onChange={() => set({ model: { lead: draft.model.lead } })} />AI 画两位新模特</label>
        <label className={"lp-chip" + (draft.model.photos ? " on" : "") + (modelShots ? "" : " off")} title={modelShots ? "" : "素材里没有模特实拍"}><input type="radio" name="faces" hidden disabled={!modelShots} checked={!!draft.model.photos}
          onChange={pickModelPhotos} />照素材里的模特画{modelShots ? `（${modelShots} 张模特图）` : "（素材里没有）"}</label>
      </div>
      {draft.model.photos && <div className="lp-faces">{GENDERS.map((g, k) => {
        const label = draft.model.photos?.[g];
        return (
          <div key={g} className="lp-face">
            <button type="button" className="pic" title="换一张" onClick={() => { setTab("推荐"); setTarget({ kind: "model", index: k }); }}>
              {label && byLabel.get(label) ? <img src={byLabel.get(label)!.url} alt="" loading="lazy" /> : <span className="none">没选{g}模特<br />AI 画一位<br /><b>点这里选</b></span>}</button>
            <span>{g}模特{label ? ` · ${label}` : ""}</span>
            {label && <button type="button" className="lp-btn link" onClick={() => set({ model: { ...draft.model, photos: { ...draft.model.photos, [g]: undefined } } })}>不用，AI 画</button>}
          </div>);
      })}</div>}
      <p className="lp-say">{castFromPhotos(draft.model)
        ? <>开始出图时，男女各出一张<b>模特定妆照</b>：照你选的人画，换上这件衣服、浅灰背景，照片里的衣服、帽子和背景不会带过去。分开画才像，所以多 1 张的钱；长相尽量照着画，不保证一模一样。后面所有有人的图都照它画，<b>是同一个人</b>。</>
        : <>开始出图时先出一张<b>模特定妆照</b>（一男一女，浅灰背景），后面所有有人的图都照它画，<b>是同一个人</b>。定妆照不满意，出图后可以「换一组模特」。</>}
        单人的图用上面选的主模特，双人的图一男一女，多人的图两位都在、其余男女交替。<br />这个版式有人的图：{category.tasks.filter(t => layout.templates[t].square.people > 0).map(t => TASK_LABEL[t]).join("、") || "无"}{layout.long.people ? "、长图" : ""}{layout.sku.people || layout.sku.specCard ? "、SKU 图" : ""}。
      </p>
    </div> : <p className="lp-say">这个版式所有图都没有人，不出模特定妆照，也不用选模特。</p>}
    {layout.sku.specCard && <>
      <h4 className="lp-h">SKU 图用谁 <small>每个颜色一张，买家切颜色时看；所有颜色的人一样大</small></h4>
      <div className="lp-model"><div className="lp-chips">{SKU_PEOPLE.map(p => (
        <label key={p} className={"lp-chip" + (skuBy === p ? " on" : "")}><input type="radio" name="skuPeople" hidden checked={skuBy === p} onChange={() => set({ skuPeople: p })} />
          {p === "实拍" ? `素材实拍（${skuReal} 个颜色有）` : p === "男女" ? "男女模特一起" : `${p}模特`}</label>))}</div>
        <p className="lp-say">{skuBy === "实拍"
          ? <>素材里有这个颜色模特图的直接用{skuDrawn ? <>，没有的 {skuDrawn} 个颜色照{skuDrawnWho(skuWho(draft, skuPair(layout)))}画（每色 1 张的钱）</> : "，这次每个颜色都有"}。</>
          : <>每个颜色都照{skuDrawnWho(skuBy)}画，不用素材里的照片（{skuDrawn} 个颜色，每色 1 张的钱）。</>}</p></div>
    </>}
    <h4 className="lp-h">出几张 <small>先出 1:1，改满意了，再一键出 3:4 和 2:3（3:4 照着改好的 1:1 重排）。1:1 少于 5 张时，留讲得最多的那几张</small></h4>
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
          <span className="grow">1:1 首图先出，3:4 首图和长图跟竖版一起出</span><button type="button" className="lp-btn link" onClick={() => set({ extra: draft.extra.filter((_, m) => m !== k) })}>移除</button></div>))}
      {free.length > 0 && <div><button type="button" className="lp-btn sm" onClick={() => set({ extra: [...draft.extra, { color: free[0].name, layout: "" }] })}>＋ 再加一套首图（换个颜色）</button></div>}
    </div>
  </>);

  /** Step 3 changes also bring in close-ups of parts the material has (a cell now showing 袖口 finds M43). */
  const change = (d: Draft) => onChange(fillParts(d, materials.sorted.images));
  /* ③ 卖点上图: the points (left) and the images (right) */
  const placeMenu = (p: Point) => {
    const all = placesFor(draft, p.id, layout), list = placing?.all ? all : all.slice(0, 3);
    return (<div className="lp-place">{list.length ? list.map(x => <button type="button" key={x.label} className={"lp-btn sm" + (x.mine && x.empty ? " primary" : "")} onClick={() => { change(putOn(draft, p.id, x)); setPlacing(null); }}>{x.label}</button>)
      : <span className="lp-muted">每张图都放满了，没有空位</span>}
      {!placing?.all && all.length > 3 && <button type="button" className="lp-btn link" onClick={() => setPlacing({ id: p.id, all: true })}>更多位置（{all.length - 3}）</button>}
      <button type="button" className="lp-btn sm ghost" onClick={() => setPlacing(null)}>取消</button></div>);
  };
  /** Go to step ① to pick a photo of a part (added to the structure images when it is not there yet). */
  const addPartPhoto = (part: string) => {
    const at = draft.parts.findIndex(x => x.part === part);
    if (at < 0) onChange({ ...draft, parts: [...draft.parts, { part, pick: null }] });
    setStep(1); setTab("全部"); setTarget({ kind: "part", index: at < 0 ? draft.parts.length : at });
  };
  /** One point: where it is on the images (with 「拿下来」) or 「没上图」 (with 「放上去」). Words on a cover's title or a sub-line are changed on the right. */
  const pointRow = (p: Point) => {
    const where = usage.get(p.id) ?? [], extra = p.source === "品类", tooLong = len(p.text) > LIMITS.cell && where.some(w => /格|标签/.test(w));
    const removable = where.some(w => /格|标签|演示/.test(w));
    // Asked for a close-up of a part the material has no photo of: told here, where the point is chosen, not at generating.
    const noPhoto = where.some(w => /格/.test(w)) && !!proofById(p.proof)?.part && !hasPart(draft, partOf(p));
    return (
      <div key={p.id} id={`lp-pt-${p.id}`} className={"lp-pp" + (where.length ? "" : " off")}>
        <div className="body">
          <input className="big" value={p.text} maxLength={LIMITS.title} aria-label="卖点" onChange={e => change(renamePoint(draft, p.id, { text: e.target.value }))} />
          <div className="meta">
            {p.group !== "定位" && <span className={"lp-tag2 g" + p.group}>{GROUP_LABEL[p.group]}</span>}<span className="lp-tag2">{p.type}</span>
            {extra && <span className="lp-tag2 y">竞品常用说法，可改</span>}
            {p.seen && <span className={"lp-tag2 seen" + p.seen}>AI 看图：{SEEN_TEXT[p.seen]}</span>}
          </div>
          {[p.seenWhy, p.evidence, p.why].filter(Boolean).length > 0 && <small className="ev">{[p.seenWhy, p.evidence, p.why].filter(Boolean).join("；")}</small>}
          {where.length ? <small className="where">→ {where.join("、")}{removable && <> <button type="button" className="lp-btn link" onClick={() => change(takeOff(draft, p.id, layout))}>拿下来</button></>}</small>
            : p.type !== "定位" && <small className="where none">没上图 <button type="button" className="lp-btn link" onClick={() => setPlacing(placing?.id === p.id ? null : { id: p.id, all: false })}>放上去</button></small>}
          {tooLong && <small className="lp-warn">放在格子和标签里最多 {LIMITS.cell} 个字，删短一点</small>}
          {noPhoto && <small className="lp-warn">素材里没有{partOf(p)}的照片，图上先用「{noPhotoProof(p, category).name}」画 <button type="button" className="lp-btn link" onClick={() => addPartPhoto(partOf(p))}>补一张{partOf(p)}的照片</button>（补好后可在右边把画法改回特写）</small>}
          {placing?.id === p.id && placeMenu(p)}
        </div>
      </div>);
  };
  const lead = draft.points.find(p => p.type === "定位");
  // The shop's services are written once in 店铺设置 and drawn on its own service image, so they are not listed here.
  const own = draft.points.filter(p => p.source === "素材" && p.type !== "定位" && p.kind !== "服务");
  const extras = draft.points.filter(p => p.source === "品类" && p.kind !== "服务");
  const onImages = (list: Point[]) => list.filter(p => usage.has(p.id)).length;
  const pool = (
    <div className="lp-pool">
      {lead && <><h4 className="lp-h">定位 <small>首图大标题，一句话说清这是什么衣服</small></h4>{pointRow(lead)}</>}
      <h4 className="lp-h">你素材里的卖点 <small>按重要程度排：你多强调 + 竞品多看重。已上图 {onImages(own)} 条，没上图 {own.length - onImages(own)} 条；不想要的「拿下来」，想加的「放上去」</small></h4>
      <div className="lp-pts">{own.map(pointRow)}</div>
      {extras.length > 0 && <>
        <h4 className="lp-h">竞品常讲、你没写的 <small>{GROUP_HINT.补充}。衣服真有才「放上去」</small></h4>
        {extras.some(p => p.kind === "衣服" && !p.folded) && <><p className="lp-sub2">衣服功能：AI 看过你的衣服图，给了判断</p><div className="lp-pts">{extras.filter(p => p.kind === "衣服" && !p.folded).map(pointRow)}</div></>}
        {extras.some(p => p.folded) && <details className="lp-more"><summary>还有 {extras.filter(p => p.folded).length} 条（排得靠后，或看着不像有）</summary><div className="lp-pts">{extras.filter(p => p.folded).map(pointRow)}</div></details>}
      </>}
      <p className="lp-say">服务（免费设计、看样、开票这些）是店铺的，在<button type="button" className="lp-btn link" onClick={onService}>店铺设置</button>里写一次，每款第 2 张自动用店铺的服务图。</p>
    </div>);

  const serviceCard = (i: number) => {
    const k = used.indexOf(i), id = masterInfo(layout.id).service, made = shop?.made[id];
    return (
      <div key={i} id={`lp-img-${i}`} className={"lp-slot" + (k < 0 ? " off" : "")}>
        <div className="who"><b>{k < 0 ? "这张不出" : `第 ${k + 1} 张`}</b><span>服务</span><small>跟着母版，自动用店铺出好的那张</small>
          {made ? <img className="lp-kept" src={made.image} alt="店铺服务图" /> : <div className="lp-kept none">店铺还没出服务图</div>}</div>
        <div className="lp-fields"><p className="lp-say lp-svc-note">{made ? "这张直接用店铺的服务图，不用填字，1:1 不花钱；3:4 竖版照它重排。" : "店铺还没出服务图：先去店铺设置写好服务、点确认，4 张服务图一起出好。"}
          服务的字在<button type="button" className="lp-btn link" onClick={onService}>店铺设置</button>里改。</p></div>
      </div>);
  };

  const imageCard = (i: number) => {
    if (draft.slots[i].shopService) return serviceCard(i);
    const setSlot = (_: number, patch: Partial<Slot>) => change({ ...draft, slots: draft.slots.map((x, m) => m === i ? { ...x, ...patch } : x) });
    const hl = (zones: string[]) => ({ onMouseEnter: () => setHover({ slot: i, zones }), onMouseLeave: () => setHover(null), onFocus: () => setHover({ slot: i, zones }), onBlur: () => setHover(null) });
    const s = draft.slots[i], k = used.indexOf(i), base = layout.templates[s.task].square, room = capacity(base), t = templateFor(layout, s), notes = notesOf(draft, i, layout);
    const leadPoint = pointOf(s.lead), acts = leadPoint && room.person ? proofsFor(leadPoint, category).filter(p => p.person) : [];
    // What the preview writes in each zone: the words, each card's point and way of drawing, the models' demonstration.
    const zoneIds = (kind: string) => t.zones.filter(z => z.kind === kind).map(z => z.id);
    const freePrintBlock = layout.id === "M2" && s.task === "首图" && !!shop?.items.some(x => x.on && x.title === "免费印绣");
    const act = proofById(s.act ?? "");
    const texts: Record<string, { text: string; note?: string }> = {
      ...Object.fromEntries(zoneIds("title").map(id => [id, { text: s.title }])),
      ...Object.fromEntries(zoneIds("sub").map(id => [id, { text: s.sub, note: s.sub ? undefined : "小字（空）" }])),
      // 暗黑科技's cover prints 免费印绣 in its black block when the shop offers it (lib/server/listing-specs.ts).
      ...Object.fromEntries(zoneIds("tag").map((id, n) => [id, n === 0 && freePrintBlock ? { text: "免费印绣", note: "店铺勾了免费印绣，固定写这四个字" } : { text: s.tags[n] ?? "", note: s.tags[n] ? "标签" : "标签（空）" }])),
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
          <SlotPreview template={t} texts={texts} active={active} width={220} /><small className="ppl">右边鼠标移到哪一项，这里对应的位置会亮</small></div>
        <div className="lp-fields">
          {i === 0 && draft.scene && (() => {
            const place = draft.scene.place as PlaceId, sell = draft.scene.sell as Sell, sc = coverScene(place, sell, draft.scene, layout.id);
            const other = () => change({ ...draft, scene: { ...draft.scene!, act: (draft.scene!.act ?? 0) + 1, look: (draft.scene!.look ?? 0) + 1 } });
            const ticked = [...new Set(draft.points.filter(p => p.on).map(p => sellOf(p.text)).filter((x): x is Sell => !!x))];
            const choices = ticked.length ? ticked : (Object.keys(SELLS) as Sell[]);
            return (<>
              <label>地点</label><span className="lp-small">{PLACES[place].name} <button type="button" className="lp-btn link" onClick={() => go(2)}>改</button></span>
              <label>首图卖点<small>画面演这个</small></label><div className="lp-chips">{choices.map(x => {
                const fits = (PLACES[place].fits as readonly string[]).includes(x);
                return <button type="button" key={x} className={"lp-chip" + (x === sell ? " on" : "") + (fits ? "" : " warn")} onClick={() => change(sellWords({ ...draft, scene: sceneAt(draft, place, x) }, x))}>{x}{fits ? "" : " !"}</button>;
              })}</div>
              <label>画面</label><div className="lp-scene"><p>{sc.line} <button type="button" className="lp-btn link" onClick={other}>换一个</button></p>{sc.hint && <p className="hint">{sc.hint}</p>}</div>
            </>);
          })()}
          {t.zones.some(z => z.kind === "badge") && <><label>工牌</label><span className="lp-small">{shop?.items.some(x => x.on && x.title === "免费印绣") ? "挂工牌，写「免费印绣」" : "挂工牌，不写字"} <span className="lp-muted">（看店铺有没有勾免费印绣）</span></span></>}
          <label>大标题</label><div className="lp-title" {...hl(zoneIds("title"))}><input className="big" value={s.title} maxLength={LIMITS.title} onChange={e => setSlot(i, { title: e.target.value })} />
            {s.task !== "首图" && titles.length > 0 && <select value="" aria-label="换一句" onChange={e => e.target.value && setSlot(i, { title: e.target.value })}><option value="">换一句…</option>{titles.map(x => <option key={x}>{x}</option>)}</select>}</div>
          {i === 0 && draft.scene && draft.scene.sell in SELLS && !SELLS[draft.scene.sell as Sell].titles.some(w => s.title.includes(w)) && <><span /><div className="lp-scene"><p className="hint">大标题没讲首图卖点「{draft.scene.sell}」，画面演的是它 <button type="button" className="lp-btn link" onClick={() => change(sellWords(draft, draft.scene!.sell as Sell))}>改成「{sellTitle(draft.scene.sell as Sell, planSeed(draft)).title}」</button></p></div></>}
          {room.sub && <><label>小字</label><input {...hl(zoneIds("sub"))} value={s.sub} maxLength={LIMITS.sub} placeholder={i === 0 ? "首图可以不写小字" : "一句说明，可空"} onChange={e => setSlot(i, { sub: e.target.value })} /></>}
          {acts.length > 0 && <><label>模特演示</label><select {...hl(zoneIds("person"))} value={s.act ?? ""} onChange={e => setSlot(i, { act: e.target.value || null })}><option value="">只穿着，不演示</option>{acts.map(a => <option key={a.id} value={a.id}>{leadPoint!.text}：{a.name}</option>)}</select></>}
          {s.cells.map((c, n) => {
            const p = pointOf(c.point), proofs = p ? proofsFor(p, category).filter(x => !x.person || base.people > 0) : [], proof = proofById(c.proof);
            return (<div key={n} className="lp-row-c">
              <label>{cellZones(t)[n]?.kind === "icon" ? `图标 ${n + 1}` : `格 ${n + 1}`}<small>{cellZones(t)[n]?.kind === "icon" ? "图标加一句" : "配一个画面"}</small></label>
              <div className="lp-cell" {...hl([cellZones(t)[n]?.id ?? ""])}>
                <select value={c.point} onChange={e => setCell(n, e.target.value)}>{[p, ...choices].filter((x): x is Point => !!x).map(x => <option key={x.id} value={x.id}>{x.text}</option>)}</select>
                <select value={c.proof} onChange={e => setSlot(i, { cells: s.cells.map((x, m) => m === n ? { ...x, proof: e.target.value } : x) })}>{proofs.map(x => { const no = !!x.part && !!p && !hasPart(draft, partOf(p)); return <option key={x.id} value={x.id} disabled={no}>{x.name}{no ? `（缺${partOf(p!)}照片）` : ""}</option>; })}</select>
                <button type="button" className="lp-btn sm ghost" aria-label="移除这格" title="移除这格，其余的格子会变大" onClick={() => setSlot(i, { cells: s.cells.filter((_, m) => m !== n) })}>✕</button>
                {proof && <small className="lp-muted" title={proof.recipe}>画面：{proof.recipe.replace("{part}", p?.part || p?.text || "")}</small>}
              </div></div>);
          })}
          {s.task !== "首图" && s.cells.length > 0 && mostCells(base) > s.cells.length && choices.length > 0 && <><span /><select className="lp-add" value="" onChange={e => { const p = pointOf(e.target.value); if (p) setSlot(i, { cells: [...s.cells, { point: p.id, proof: fitProof(p, base, category) }] }); }}>
            <option value="">{room.cells > s.cells.length ? `＋ 加一格（还能加 ${room.cells - s.cells.length} 格）` : `＋ 挤一格（格子会变小，最多 ${mostCells(base)} 格）`}</option>{choices.map(p => <option key={p.id} value={p.id}>{p.text}</option>)}</select></>}
          {room.tags > 0 && <><label>标签<small>小胶囊字</small></label><div className="lp-chips" {...hl(zoneIds("tag"))}>{s.tags.map((tg, n) => <span key={n} className="lp-tagx">{tg}<button type="button" aria-label="移除" title="移除" onClick={() => setSlot(i, { tags: s.tags.filter((_, m) => m !== n) })}>×</button></span>)}
            {s.tags.length < room.tags && <select value="" onChange={e => e.target.value && setSlot(i, { tags: [...s.tags, e.target.value] })}><option value="">＋ 加标签</option>{choices.map(p => <option key={p.id} value={p.text}>{p.text}</option>)}</select>}
            <small className="lp-muted">图上的小胶囊字（预览里绿色的小块），补一句卖点，不配画面；最多 {room.tags} 个</small></div></>}
          {showsGarment(layout, s.task) && <><label>颜色<small>衣服穿哪个色</small></label><div className="lp-chips" {...hl([...zoneIds("person"), ...zoneIds("garment")])}>{ok.map(c => (
            <button type="button" key={c.name} className={"lp-chip" + (s.colors.includes(c.name) ? " on" : "")} disabled={i === 0} onClick={() => pickColor(i, c.name)}><span className="dotc" style={{ background: c.hex || "#999" }} />{c.name}</button>))}
            <small className="lp-muted">{i === 0 ? "首图跟主推色，在第 ① 步改" : `${i === draft.slots.length - 1 ? `多选，最多 ${CLOSER_MAX} 个` : "单选"} · ${s.why ?? ""}`}</small>
            {s.manual && <button type="button" className="lp-btn link" onClick={() => change({ ...draft, slots: colorize(draft, layout, draft.slots.map((x, m) => m === i ? { ...x, manual: false } : x)) })}>按规则重排</button>}</div></>}
          {missing.map(({ n, p }) => {
            const alt = proofsFor(p, category).find(x => !x.part && !x.person) ?? proofById("icon-text")!;
            return (<div key={"m" + n} className="lp-fix"><b>格 {n + 1}「{p.text}」要拍{partOf(p)}特写，可素材里没有{partOf(p)}的照片</b>（AI 在全部素材里找过了）。
              <span><button type="button" className="lp-btn sm" onClick={() => setSlot(i, { cells: s.cells.map((x, m) => m === n ? { ...x, proof: alt.id } : x) })}>改成「{alt.name}」</button>
                <button type="button" className="lp-btn sm" onClick={() => addPartPhoto(partOf(p))}>补一张{partOf(p)}的照片</button>
                <button type="button" className="lp-btn sm ghost" onClick={() => setSlot(i, { cells: s.cells.filter((_, m) => m !== n) })}>移除这格</button></span></div>);
          })}
          {notes.filter(x => !missing.some(m => x.includes(`「${m.p.text}」要拍`))).map(x => <p key={x} className="lp-warn lp-note">! {x}</p>)}
        </div>
      </div>);
  };
  const images = (
    <div className="lp-images">
      <p className="lp-say">每张图的排法来自上一步的母版「<b>{layout.name}</b>」。<b>几张图讲什么、每张几格，跟着左边上图的卖点走</b>：功能卖点做功能图，做工、实用做细节图，卖点不够时出一张场景图。格子里的字就是左边的卖点，改字去左边改；大标题可以换、可以改。<b>这里的字就是印到图上的字。</b></p>
      {hint && <div className="lp-alert y lp-hint">按现在上图的卖点，可以{hint}。<button type="button" className="lp-btn sm" onClick={() => { if (window.confirm("按现在上图的卖点重排每张图？右边改过的标题和格子会重新排，颜色你选过的保留；拿下来的卖点不会再放回去。")) change(rearrange(draft, layout, false)); }}>按新卖点重排每张图</button></div>}
      <div className="lp-slots">{draft.slots.map((_, i) => imageCard(i))}</div>
      {draft.counts.long > 0 && <>
        <h4 className="lp-h">2:3 长图 <small>手淘推荐流里的竖版长图：{draft.counts.square > 0 ? "照 1:1 首图重排，字和字体都跟首图一样，人拉远、头部完整" : "人物完整、只有一行字，不放标签和格子"}</small></h4>
        <div className="lp-slot"><div className="who"><b>长图</b><Wire template={layout.long} ratio={2 / 3} width={84} /><small className="ppl">{PEOPLE_LABEL(layout.long)}</small></div><div className="lp-fields">
          {/* From the square cover (its words, word for word); only a set with no square images writes its own line. */}
          {draft.counts.square > 0 ? <><label>字</label><div className="lp-scene"><p>和首图一样：{[draft.slots[0]?.title, draft.slots[0]?.sub, ...(draft.slots[0]?.tags ?? [])].filter(Boolean).join(" / ")}。要改字，改上面的首图。</p></div></>
            : <><label>一行字</label><input className="big" value={draft.long.title} maxLength={LIMITS.title} onChange={e => change({ ...draft, long: { title: e.target.value } })} /></>}</div></div></>}
    </div>);
  const mapStep = <div className="lp-map">{pool}{images}</div>;
  /** The images other than the 1:1 main images, one line each: 白底产品图 2 张, SKU 图 2 张… */
  const others = (lines: PriceLine[]) => lines.filter(l => !l.label.startsWith("1:1 主图") && l.label !== "店铺服务图（已存）").reduce<{ label: string; count: number; note: string }[]>((out, l) => {
    const label = l.label.replace("（多色同框）", ""), same = out.find(x => x.label === label);
    if (same) same.count += l.count; else out.push({ label, count: l.count, note: l.note });
    return out;
  }, []);
  const credits = (n: number) => prices.exempt ? null : <span className="lp-muted">约 {n} 积分</span>;
  const confirmStep = (
    <div className="lp-confirm4">
      <p className="lp-cfg"><span>母版 <b>{layout.name}</b></span><span>胸口 <b>{logoMode === "不印" ? "不印字" : logoMode === "LOGO" ? "印「LOGO」字样，告诉买家能印标" : logoMode === "样例" ? "印店铺的样例 LOGO" : `印客户 LOGO（${draft.logo?.label ?? "还没上传"}）`}</b></span></p>
      <h4 className="lp-h">现在出 {cost.now.images} 张 {credits(cost.now.credits)} <small>出图约 3–5 分钟，可以关掉页面，做好的会陆续出现</small></h4>
      <ol className="lp-shots">{used.map((i, k) => {
        const s = draft.slots[i], notes = notesOf(draft, i, layout), cover = i === 0 && draft.scene;
        const words = [...s.cells.map(c => pointOf(c.point)?.text), ...s.tags].filter(Boolean).join("、");
        return (<li key={i} className={notes.length ? "y" : ""}>
          <span className="no">第 {k + 1} 张</span>
          <div className="what">
            <b>{s.shopService ? "店铺服务图" : `${TASK_LABEL[s.task]}${s.title.trim() ? `　「${s.title}」` : ""}`}</b>
            {s.shopService ? <small>用店铺存好的那张，免费 · <button type="button" className="lp-btn link" onClick={onService}>去店铺设置看看</button></small>
              : <small>{cover ? coverScene(draft.scene!.place as PlaceId, draft.scene!.sell as Sell, draft.scene!, layout.id).line : words || s.sub}{s.colors.length > 0 && <span className="lp-muted"> · {s.colors.join("、")}</span>}</small>}
            {notes.map(n => <small key={n} className="note">! {n}</small>)}
          </div>
          {notes.length > 0 && <button type="button" className="lp-btn sm" onClick={() => jump(k + 1)}>去改</button>}
        </li>);
      })}
        {others(cost.now.lines).map((l, n) => <li key={"o" + n}><span className="no">{l.count} 张</span><div className="what"><b>{l.label}</b>{l.note && <small>{l.note}</small>}</div></li>)}
      </ol>
      {cost.later.images > 0 && <><h4 className="lp-h">以后再出 {cost.later.images} 张 {credits(cost.later.credits)} <small>这一轮的方图满意了，在出图结果里点「出竖版」再出</small></h4>
        <ol className="lp-shots">{others(cost.later.lines).map((l, n) => <li key={n}><span className="no">{l.count} 张</span><div className="what"><b>{l.label}</b>{l.note && <small>{l.note}</small>}</div></li>)}</ol></>}
      <p className="lp-muted lp-small">没出成功的图会自动退积分。</p>
    </div>);

  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan wide" role="dialog" aria-modal="true" aria-label="定方案">
        <div className="lp-box-head"><div><h3>定方案 · {name}</h3><p className="lp-sub">AI 已经整理好素材，下面每一项都是它的建议，不对的直接改。点「开始出图」之前不花钱。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-stepbar">{STEPS.map((s, i) => <button type="button" key={s} className={step === i + 1 ? "on" : i === 0 && check.red.length ? "bad" : i === 2 && check.warn.length ? "warn" : "ok"} onClick={() => go(i + 1)}>{s}</button>)}</div>
        <div className={"lp-box-body" + (step === 3 ? " map" : "")} key={step}>{step === 1 ? step1 : step === 2 ? layoutStep : step === 3 ? mapStep : confirmStep}</div>
        <div className="lp-box-foot">
          <div className="grow">{check.red.length ? <span className="lp-bad">{check.red[0]}</span> : step === 4 ? <>共 {cost.now.images} 张{!prices.exempt && <>，约 <b>{cost.now.credits}</b> 积分 <PriceInfo lines={cost.now.lines} total={cost.now.credits} extra="分析费已在整理时扣过" /></>}</> : <>现在出 {cost.now.images} 张（白底图、{cast ? "定妆照、" : ""}SKU 图、1:1 主图）{!prices.exempt && <>，约 <b>{cost.now.credits}</b> 积分 <PriceInfo lines={cost.now.lines} total={cost.now.credits} extra="分析费已在整理时扣过" /></>}
            {cost.later.images > 0 && <span className="lp-muted"> · 竖版 {cost.later.images} 张以后再出{!prices.exempt && `，约 ${cost.later.credits} 积分`}</span>}
            {check.warn.length > 0 && <span className="lp-warn"> · 有提醒：{check.warn.map(k => <button type="button" key={k} className="lp-btn link" onClick={() => jump(k)}>第 {k} 张</button>)}</span>}</>}</div>
          {step > 1 && <button type="button" className="lp-btn" onClick={() => go(step - 1)}>上一步</button>}
          {step < 4 ? <button type="button" className="lp-btn primary" disabled={check.red.length > 0} onClick={() => go(step + 1)}>下一步</button>
            : <button type="button" className="lp-btn primary" disabled={busy || check.red.length > 0} onClick={async () => { setBusy(true); try { await onStart(); } finally { setBusy(false); } }}>{busy ? "正在开始…" : `开始出图${prices.exempt ? "" : ` · 约 ${cost.now.credits} 积分`}`}</button>}
        </div>
      </div>

      {target && (
        <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) setTarget(null); }}>
          <div className="lp-box" role="dialog" aria-modal="true" aria-label="选一张图">
            <div className="lp-box-head"><div><h3>{target.kind === "model" ? `选${GENDERS[target.index]}模特的照片` : target.kind === "color" ? `选「${draft.colors[target.index].name}」的衣服图` : `选结构图「${draft.parts[target.index]?.part ?? ""}」`}</h3>
              <p className="lp-sub">{target.kind === "model" ? "挑一张只有一个人、脸正面清楚、没戴墨镜口罩的。后面的图都照这个人画，照片里的衣服和背景不会带过去。" : target.kind === "color" ? "要衣服完整、正面、颜色准。推荐里是 AI 认为是这个颜色的图。" : draft.parts[target.index]?.part === FRONT ? "衣服完整的正面图" : `「${draft.parts[target.index]?.part ?? ""}」的特写，挑最清楚的一张；名字不对可以在外面改`}</p></div>
              <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={() => setTarget(null)}>关闭</button></div>
            <div className="lp-box-body">
              <div className="lp-tabs">{["推荐", "全部", ...KINDS].map(k => <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}</div>
              <div className="lp-lib">{shown.length ? shown.map(i => (
                <button type="button" key={i.label} className="it" onClick={() => assign(i.label)}><img src={i.url} alt="" loading="lazy" /><span className="cat">{sorted.get(i.label)?.kind}{sorted.get(i.label)?.color ? "·" + sorted.get(i.label)!.color : ""}</span><small>{i.path}</small></button>))
                : <span className="lp-muted">素材里没有推荐的图，可以看「全部」或补传一张。</span>}</div>
            </div>
            <div className="lp-box-foot"><div className="grow">{target.kind === "part" && draft.parts[target.index]?.part !== FRONT
              ? <button type="button" className="lp-btn link" onClick={() => { set({ parts: draft.parts.filter((_, k) => k !== target.index) }); setTarget(null); }}>移除这个部位（出图时不做特写）</button> : "素材里没有合适的？"}</div>
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
