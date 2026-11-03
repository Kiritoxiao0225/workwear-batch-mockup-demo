"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图「定方案」, four steps: ① this product — its category, each colour's garment image, what the
 * chest shows; ② the master (母版), where its cover is shot when it is shot on location, the model
 * and the counts; ③ 卖点上图 — the points on the left and the images on the right, the cover's point
 * acted out in its picture; ④ what is made and what it costs. A point's words are kept in one place,
 * the list; the images use them. Nothing is paid before 「开始出图」.
 */
import { SkuLeftPreview } from "./listing-sku-fields";
import { useEffect, useRef, useState } from "react";
import type { LayoutCard, Materials, Source } from "@/lib/listing/api-types";
import { assetUrl } from "@/lib/listing/client-api";
import { CATEGORIES, categoryById, GROUP_HINT, GROUP_LABEL, TASK_HINT, TASK_LABEL } from "@/lib/listing/category";
import {
  checkDraft, CLOSER_MAX, colorize, defaultDraft, directKeys, draftImages, FRONT, LIMITS, notesOf, placesFor, priceLines, proofsFor, renamePoint, replan, showsGarment, structureHint, sumCredits, syncCloser,
  templateFor, takeOff, putOn, usageOf, usedSlots, fitProof, fillParts, fillModel, modelPhotos, castFromPhotos, GENDERS, missingParts, partOf, wantsCast, hasPart, noPhotoProof, reusedSlots,
  SKU_PEOPLE, skuItemsOf, colorKeys, type Counts, type Draft, type Point, type PriceLine, type Slot,
} from "@/lib/listing/draft";
import { isComponent } from "@/lib/listing/garment-role";
import { proofById } from "@/lib/listing/proofs";
import { auditDraft, type AuditFix } from "@/lib/listing/audit";
import { colorRow, fieldRows, SKU_AUTO, SKU_AUTO_SET, SKU_WORD_MAX, skuCardRows, skuFieldName, skuFieldsUsed, skuPhotos, skuSetOf, styleNo, type SkuWordField } from "@/lib/listing/sku-card";
import { linerName, linerPhoto, versionName, WEAR_LABEL, WEARS } from "@/lib/listing/wear";
import { draftVersions, itemPhoto, linerAlone, linerByColor, linerColors, linerFor, linersSeen, mainLiner, VERSION_KINDS, type DraftVersion, type SkuItem } from "@/lib/listing/sku-versions";
import { LinerDialog } from "./listing-liner";
import { heatPoint, insideFor, isInside } from "@/lib/listing/inside";
import type { LinerTag } from "@/lib/listing/client-api";
import { capacity, cellZones, COVER_PEOPLE, coverPeopleOf, mostCells, PEOPLE_LABEL, skuPair, withCover, type Layout } from "@/lib/listing/templates";
import { SlotPreview, Wire } from "./listing-wire";
import { bestSell, coverPicks, coverScene, isSellTitle, masterInfo, PLACE_IDS, PLACES, seedOf, SELLS, sellOf, sellTitle, type PlaceId, type Sell } from "@/lib/listing/scene";
import { useShopState } from "./listing-service";

export const KINDS = ["颜色款图", "静物", "3D渲染", "模特实拍", "细节特写", "卖点图", "详情页", "海报", "尺码表", "无关"] as const;
export type Prices = { image: number; multi: number; exempt: boolean };

const live = (d: Draft) => d.colors.filter(c => c.pick);
/** The colours (by image label) the material has its own model photo of, for their SKU images. */
const photosOf = (d: Draft, m: Materials, layout: Layout) => new Set(Object.keys(skuPhotos({ colors: live(d), model: d.model, skuPeople: d.skuPeople, versions: d.versions }, m.sorted.images, skuPair(layout))));
const len = (s: string) => [...s.trim()].length;
export const layoutOf = (layouts: LayoutCard[], id: string): Layout => layouts.find(l => l.id === id) ?? layouts[0];

/** The AI's plan as the starting point; `category` overrides the AI's call. */
export function startDraft(m: Materials, layout: Layout, counts?: Counts, category = m.category): Draft {
  const d = fillModel(fillParts(defaultDraft({ category, categoryWhy: m.categoryWhy, checks: m.checks, titles: m.titles, points: m.sorted.points, colors: m.chosen.colors, parts: m.chosen.parts }, layout, counts), m.sorted.images), m.sorted.images);
  // 「再出一套」 (11-01): the first product's choices on how it is worn (an 一体 jacket's inside photos, its box, open) carry
  // over while the type is the same, and the copy dialog's cover (who, worn open) goes on top.
  const read = wearOf(m, d.main), kept = read && m.reuse?.wear?.type === read.type ? { ...read, ...m.reuse.wear } : read;
  const worn = kept && kept.type === "一体" && m.cover?.open !== undefined ? { ...kept, open: m.cover.open } : kept;
  const versions = m.wear?.type === "内胆" && m.wear.versions.length ? draftVersions(m.wear.versions) : undefined;
  return lookScene({ ...(m.variant ? { ...d, seed: m.variant } : d), ...(worn ? { wear: worn } : {}), ...(versions ? { versions } : {}), ...(m.cover?.people ? { coverPeople: m.cover.people } : {}) }, layout, m.look);
}
/**
 * How it is worn, from the material's reading (wear.ts): 有内胆 needs a photo of the shell over its
 * liner to draw from (the main colour's first); without one it is worn as 春秋薄款.
 */
export function wearOf(m: Materials, main: string): Draft["wear"] {
  const w = m.wear;
  if (!w) return undefined;
  // 一体 (10-29): the SKU images' small box of the inside is ticked; the user unticks it for none.
  if (w.type === "一体") return { type: "一体", box: true };
  if (w.type !== "内胆") return { type: w.type };
  const v = w.versions.find(x => x.kind === "外壳加内胆"), liner = v ? linerPhoto(m.sorted.images, v.inner, main) : null;
  return liner ? { type: "内胆", liner } : { type: "薄款" };
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
  return rearrange({ ...fresh, colors: d.colors, main: d.main, parts: d.parts, logo: d.logo, model: d.model, skuPeople: d.skuPeople, skuFields: d.skuFields, skuWords: d.skuWords, coverPeople: d.coverPeople, wear: d.wear, versions: d.versions, extra: d.extra, scene: d.scene, ...(d.shop ? { shop: d.shop } : {}) }, layout, false);
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

const STEPS = ["① 确认这款", "② 选母版", "③ 卖点上图", "④ 出多少、确认出图"];
/** What a master's five samples are, in order; the sample an image of each kind is shown with on ③. */
const SAMPLE_CAPTION = ["首图", "店铺服务图", "功能", "细节", "收口"];
const SAMPLE_OF: Partial<Record<string, number>> = { 首图: 0, 服务: 1, 功能: 2, 细节: 3, 实用: 3, 收口: 4 };
/** The points not on an image yet, by kind (11-03). */
const POOL_GROUPS: [string, string[]][] = [["功能", ["功能"]], ["做工", ["做工"]], ["实用", ["实用"]], ["面料", ["面料"]], ["场景", ["人群场景"]], ["其他", ["颜色款式", "服务定制", "定位"]]];
/** What the picker fills: a colour's garment image, a structure image, or the man's (0) or woman's (1) model photo. */
/** `open`: the inside picked for the main colour on ticking the open cover, which is ticked with it (10-29). */
type Target = { kind: "color" | "part" | "model" | "version" | "inside"; index: number; open?: boolean } | null;
const SEEN_TEXT = { 有: "看得出有", 看不出: "看图看不出", 不像: "看着不像有" } as const;

export function PlanDialog({ projectId, name, materials, sources, draft, layouts, prices, onChange, onUpload, onRefresh, onService, onClose, onStart }: {
  projectId: string;
  /** Reads the product again: a drawn liner taken into the material (10-22). */
  onRefresh: () => Promise<void>;
  name: string; materials: Materials; sources: Source[]; draft: Draft; layouts: LayoutCard[]; prices: Prices;
  onChange: (d: Draft) => void; onUpload: (file: File, liner?: LinerTag) => Promise<{ label: string }>; onService: () => void; onClose: () => void; onStart: () => Promise<void>;
}) {
  const [step, setStep] = useState(1);
  const [target, setTarget] = useState<Target>(null);
  const [tab, setTab] = useState("推荐");
  const [libTab, setLibTab] = useState("全部");
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState<{ id: string; all: boolean } | null>(null);
  const [hover, setHover] = useState<{ slot: number; zones: string[] } | null>(null);
  const [moved, setMoved] = useState("");
  /** Step ③: the image being edited (11-03). */
  const [cur, setCur] = useState(0);
  /** The liner panel (10-22): a new liner colour for a version's shell colour, or a liner tidied onto white (`color`). */
  const [linerOpen, setLinerOpen] = useState<{ inner: string; name?: string; color?: string; version?: number; shell?: string } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const logoUpload = useRef<HTMLInputElement>(null);
  // The shop the product is for (10-22): the plan's choice, a copy's first product's, else the default one.
  const shopState = useShopState(draft.shop ?? materials.shop), shop = shopState?.shop ?? null, shops = shopState?.sets ?? [];
  // The master as chosen, and with the cover's people the plan picked (11-01, step ②「首图」).
  const rawLayout = layoutOf(layouts, draft.layout), layout = withCover(rawLayout, draft), category = categoryById(draft.category);
  const sorted = new Map(materials.sorted.images.map(i => [i.id, i]));
  const byLabel = new Map(materials.images.map(i => [i.label, { label: i.label, url: assetUrl(i.assetId), path: sources.find(s => s.id === i.assetId)?.path ?? i.label }]));
  const copies = [...materials.duplicates.map(([copy, keep]) => ({ copy, keep })), ...materials.sorted.images.filter(i => i.same).map(i => ({ copy: i.id, keep: i.same }))];
  const library = [...byLabel.values()].filter(i => !copies.some(c => c.copy === i.label));
  const check = checkDraft(draft, layout, materials.sorted.images), cost = draftPrice(draft, materials, layout, prices), ok = live(draft);
  const used = usedSlots(draft, draft.counts.square), usage = usageOf(draft), hint = structureHint(draft, layout);
  const pointOf = (id: string | null | undefined) => draft.points.find(p => p.id === id);
  const on = draft.points.filter(p => p.on && p.type !== "定位");
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  /** The material's images as sorted, liners added on the plan among them (their tags come with the upload, 10-22). */
  const linerImages = materials.sorted.images;
  /** The liner names the material has (10-28), the most seen first: what 「＋ 新增」 offers before the user writes one. */
  const innerNames = (() => { const n = new Map<string, number>(); for (const i of linerImages) if (i.inner) n.set(i.inner, (n.get(i.inner) ?? 0) + 1); return [...n].sort((a, b) => b[1] - a[1]).map(([k]) => k); })();
  /** A colour's inside photo (10-29): '' leaves its SKU box empty. */
  const setInside = (i: number, label: string, open?: boolean) => { const key = colorKeys(draft.colors)[i]; if (key && draft.wear) set({ wear: { ...draft.wear, insides: { ...draft.wear.insides, [key]: label }, ...(open ? { open } : {}) } }); };
  /** One photo of the inside for every colour: the material often shoots its close-ups in one colour only (10-29: 8826). */
  const insideAll = (label: string) => { if (draft.wear) set({ wear: { ...draft.wear, insides: Object.fromEntries(colorKeys(draft.colors).flatMap(k => k ? [[k, label]] : [])) } }); };
  const setVersion = (i: number, patch: Partial<DraftVersion>) => set({ versions: (draft.versions ?? []).map((v, k) => k === i ? { ...v, ...patch } : v) });
  const candidates = (t: NonNullable<Target>) => {
    if (t.kind === "color") {
      const c = draft.colors[t.index], chosen = materials.chosen.colors.find(x => x.name === c.name)?.candidates ?? [];
      return library.filter(i => !isComponent(sorted.get(i.label)) && (chosen.includes(i.label) || sorted.get(i.label)?.color === c.name));
    }
    // A version the user adds is drawn from an image of it: the ones showing a liner first.
    if (t.kind === "version") return library.filter(i => !!sorted.get(i.label)?.inner || sorted.get(i.label)?.role === "内胆");
    // The inside of an 一体 jacket (10-29): the close-ups read as its inside, then the other close-ups.
    if (t.kind === "inside") return [...library.filter(i => { const s = sorted.get(i.label); return !!s && isInside(s); }), ...library.filter(i => { const s = sorted.get(i.label); return !!s && !isInside(s) && s.kind === "细节特写"; })];
    if (t.kind === "model") {
      const known = materials.sorted.images.some(i => i.person !== undefined), fit = known ? modelPhotos(materials.sorted.images, GENDERS[t.index]) : materials.sorted.images.filter(i => i.kind === "模特实拍" && !i.same);
      return fit.map(i => byLabel.get(i.id)).filter((i): i is NonNullable<typeof i> => !!i);
    }
    const part = draft.parts[t.index]?.part ?? "", chosen = materials.chosen.parts.find(x => x.part === part)?.candidates ?? [];
    return library.filter(i => chosen.includes(i.label) || (part !== FRONT && sorted.get(i.label)?.kind === "细节特写"));
  };
  const assign = (label: string) => {
    if (!target) return;
    if (target.kind === "version") set({ versions: (draft.versions ?? []).map((v, k) => k === target.index ? { ...v, ref: label } : v) });
    else if (target.kind === "inside") setInside(target.index, label, target.open);
    else if (target.kind === "model") set({ model: { ...draft.model, photos: { ...draft.model.photos, [GENDERS[target.index]]: label } } });
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
  const logoMode = draft.logo?.mode ?? "LOGO", wearType = draft.wear?.type ?? "薄款";
  // A shop with a sample LOGO prints it on the chest unless the plan says otherwise (10-21).
  // A sample LOGO deleted since: the word 「LOGO」, as the shop page says.
  useEffect(() => {
    if (!draft.logo && shop?.logo) onChange({ ...draft, logo: { mode: "样例" } });
    else if (shop && !shop.logo && draft.logo?.mode === "样例") onChange({ ...draft, logo: { mode: "LOGO" } });
  }, [draft, shop, onChange]);
  const photos = photosOf(draft, materials, layout), cast = wantsCast(draft, layout, photos);
  /* shared by the steps */
  // 首图人物 (11-01): the plan's choice, else the master's.
  const coverWho = coverPeopleOf(layout, draft), coverDefault = coverPeopleOf(rawLayout, { model: draft.model });
  // SKU 图左边 (11-01): the combo the product uses and what it will say, with the colour standing in for every colour's name.
  const skuSet = skuSetOf(shop?.skuFields, draft.skuFields);
  const skuCard = { name, category: draft.category, points: draft.points, words: draft.skuWords, outer: draft.wear?.type === "内胆" || draft.wear?.type === "一体" };
  const skuFieldRows = fieldRows(skuCard), skuPreview = skuCardRows(skuCard, skuSet, colorRow("颜色"));
  // 自动 always offers the 货号 box: typing one gives it its row.
  const skuWordFields = skuSet.fields.length ? skuFieldsUsed(skuCard, skuSet) : [...new Set<SkuWordField>(["style", ...skuFieldsUsed(skuCard, skuSet)])];
  const skuMissing = skuSet.fields.filter((f): f is SkuWordField => f !== "color" && !skuFieldRows[f]);
  const skuBy = draft.skuPeople ?? "实拍";
  const modelShots = materials.sorted.images.filter(i => i.kind === "模特实拍" && !i.same).length;
  /** Draw the cast from the material: the clearest man and woman picked, or none yet. */
  const pickModelPhotos = () => {
    const filled = fillModel({ ...draft, model: { lead: draft.model.lead } }, materials.sorted.images).model;
    set({ model: filled.photos ? filled : { lead: draft.model.lead, photos: {} } });
  };
  const setCount = (key: keyof Counts, n: number) => {
    const counts = { ...draft.counts, [key]: n };
    if (key === "square") counts.portrait = Math.min(counts.portrait, n);
    set({ counts });
  };
  const look = materials.look;
  // The versions in full (10-22): add one, rename a liner, which liner colour each shell colour wears, a liner tidied onto white.
  const countOf = (v: DraftVersion) => { const own = skuItemsOf(draft).filter(i => i.version?.key === v.key); return { all: own.length, real: own.filter(i => photos.has(i.key)).length }; };
  const versionsEditor = (<>
      <p className="lp-say">每种穿法一行：不卖的去掉勾，漏掉的点「＋ 新增一个版本」。外套里穿内胆时，每个颜色配哪件内胆在这里改。</p>
      <div className="lp-versions">{(draft.versions ?? []).map((v, i) => {
        const read = materials.wear?.versions.find(x => x.kind === v.kind && x.inner === v.inner), seen = read?.colors ?? [];
        // A liner worn alone comes in every colour the material (or the plan, 10-22) has it in.
        const all = v.kind === "单内胆" ? [...new Set([...seen, ...linerColors(materials.sorted.images, v.inner), ...v.colors])] : live(draft).map(c => c.name), n = countOf(v);
        const proof = v.added ? (v.ref ? [v.ref] : []) : (read?.from ?? []).slice(0, 3);
        return (<div key={v.key} className={"row" + (v.on ? "" : " off")}>
          <div className="head">
            <label className="name"><input type="checkbox" checked={v.on} onChange={e => setVersion(i, { on: e.target.checked })} />
              {v.added ? <><select value={v.kind} onChange={e => setVersion(i, { kind: e.target.value as DraftVersion["kind"], inner: e.target.value === "单外壳" ? "" : v.inner || innerNames[0] || "", colors: [] })}>{VERSION_KINDS.map(k => <option key={k} value={k}>{k === "外壳加内胆" ? "外壳 + 内胆" : k === "单内胆" ? "单穿内胆" : k}</option>)}</select>
                {v.kind !== "单外壳" && <InnerPick value={v.inner} names={innerNames} onChange={inner => setVersion(i, { inner, name: undefined })} />}
                <span className="lp-chip-s">你加的</span></> : v.kind === "单外壳" ? <b>单外壳</b> : <>
                <b>{v.kind === "外壳加内胆" ? "外壳 +" : "单穿"}</b><input className="lp-in xs" value={linerName(v)} maxLength={6} title="内胆叫什么：SKU 图和规格名都用这个名字"
                  onChange={e => { const name = e.target.value.trim(); setVersion(i, { name: name === v.inner ? undefined : name }); }} /><b>内胆</b>
                {read?.said === false && !v.name && <span className="lp-chip-s warn" title="素材的文件夹、文件名和文字里都没写这件内胆叫什么，名字是 AI 看图起的">AI 看图起的名，请确认</span>}</>}</label>
            <span className="lp-muted lp-small">{v.on && n.all ? `${n.all} 张${n.real ? `，${n.real} 张用素材实拍` : ""}${n.all - n.real ? `，${n.all - n.real} 张要画` : ""}` : "不出"}</span>
            {v.added && <button type="button" className="lp-btn link" onClick={() => set({ versions: draft.versions!.filter((_, k) => k !== i) })}>删掉</button>}
          </div>
          <div className="body">
            <div className="lp-chips">{all.map(n => <button type="button" key={n} className={"lp-chip" + (v.colors.includes(n) ? " on" : "") + (v.added || v.kind === "单内胆" || seen.includes(n) ? "" : " unseen")}
              title={v.added || seen.includes(n) ? "" : "素材里没拍到这个颜色的这个穿法，勾上会照别的颜色画"} onClick={() => setVersion(i, { colors: v.colors.includes(n) ? v.colors.filter(x => x !== n) : [...v.colors, n] })}>{n}</button>)}
              {v.added && v.kind === "单内胆" && <input className="lp-in sm" placeholder="内胆颜色，回车加" onKeyDown={e => { const c = e.currentTarget.value.trim(); if (e.key === "Enter" && c) { setVersion(i, { colors: [...new Set([...v.colors, c])] }); e.currentTarget.value = ""; } }} />}</div>
            {proof.length > 0 && <div className="proof">{proof.map(l => byLabel.get(l) && <a key={l} href={byLabel.get(l)!.url} target="_blank" rel="noreferrer" title={byLabel.get(l)!.path}><img src={byLabel.get(l)!.url} alt="" loading="lazy" /></a>)}<span className="lp-muted lp-small">{v.added ? "参考图" : "依据"}</span></div>}
          </div>
          {/* Over a liner: which liner colour each shell colour wears (10-22); the material's where it shows one, else zipped up unless the user picks. */}
          {v.kind === "外壳加内胆" && v.colors.length > 0 && <div className="liners">{v.colors.map(c => {
            const seenHere = linersSeen(materials.sorted.images, v.inner, c), value = linerFor(materials.sorted.images, v, c);
            const options = [...new Set([...linerColors(materials.sorted.images, v.inner), ...(value ? [value] : [])])];
            return (<label key={c} className={seenHere.length ? "" : "guess"}><b>{c}</b><span className="lp-muted">配</span>
              <select value={value} onChange={e => e.target.value === "＋" ? setLinerOpen({ inner: v.inner, name: linerName(v), version: i, shell: c }) : setVersion(i, { liners: { ...v.liners, [c]: e.target.value } })}>
                {options.map(o => <option key={o} value={o}>{o}{linerName(v)}内胆{seenHere.includes(o) ? "（素材拍到）" : ""}</option>)}
                <option value="">拉链拉上，不露内胆</option>
                <option value="＋">＋ 新增内胆颜色…（上传或 AI 生成）</option></select>
              {!seenHere.length && <small>素材里没拍到{c}配这件内胆，{value ? "照你选的颜色画" : "先拉链拉上画，知道配什么就选上"}</small>}</label>);
          })}</div>}
          {/* The liner's own images, one per colour it comes in: the SKU card shows these; tidied onto white here. */}
          {v.kind !== "单外壳" && v.inner && (() => {
            const shown = v.kind === "单内胆" ? v.colors : [...new Set(v.colors.map(c => linerFor(linerImages, v, c)).filter(Boolean))];
            return shown.length > 0 && <div className="liner-pics"><span className="lp-muted lp-small">内胆图</span>{shown.map(col => {
              const pic = linerAlone(linerImages, v.inner, col), img = pic ? byLabel.get(pic) : undefined, white = pic && linerImages.find(x => x.id === pic)?.kind === "静物";
              return (<span key={col} className="lp-liner-tile">{img ? <a href={img.url} target="_blank" rel="noreferrer"><img src={img.url} alt="" /></a> : <span className="none">没有</span>}
                <small>{col}{linerName(v)}</small><button type="button" className="lp-btn link" onClick={() => setLinerOpen({ inner: v.inner, name: linerName(v), color: col })}>{white ? "重做" : "整理成白底图"}</button></span>);
            })}</div>;
          })()}
          {v.added && v.kind !== "单外壳" && <div className="ref">
            {v.kind === "外壳加内胆" && <label><input type="radio" name={`ref-${v.key}`} checked={!v.ref} onChange={() => setVersion(i, { ref: undefined })} /> 不选参考图：模特拉链拉到顶，看不到内胆，不会画错</label>}
            <label><input type="radio" name={`ref-${v.key}`} checked={!!v.ref || v.kind === "单内胆"} onChange={() => { setTab("推荐"); setTarget({ kind: "version", index: i }); }} /> {v.ref ? <>照这张画：{v.ref} <button type="button" className="lp-btn link" onClick={() => { setTab("推荐"); setTarget({ kind: "version", index: i }); }}>换一张</button></> : v.kind === "单内胆" ? <>要选一张这件内胆的照片 <button type="button" className="lp-btn link" onClick={() => { setTab("推荐"); setTarget({ kind: "version", index: i }); }}>选图</button></> : "选一张图照着画（外套敞开、露出内胆）"}</label>
          </div>}
        </div>);
      })}
        <div className="more"><button type="button" className="lp-btn" onClick={() => set({ versions: [...(draft.versions ?? []), { key: `v${Math.max(0, ...(draft.versions ?? []).map(v => Number(v.key.slice(1)) || 0)) + 1}`, kind: "外壳加内胆", inner: innerNames[0] ?? "", colors: [], on: true, added: true }] })}>＋ 新增一个版本</button></div></div>
  </>);
  const partsGrid = (
    <div className="lp-parts">{draft.parts.map((p, i) => (
      <div key={i} className={"lp-part" + (!p.pick && p.part === FRONT ? " missing" : "")}>
        <button type="button" className="pic" title="换一张" onClick={() => { setTab("推荐"); setTarget({ kind: "part", index: i }); }}>
          {p.pick ? pic(p.pick) : <span className="none">{p.part === FRONT ? "缺正面全身图，点这里补" : "还没选图，点这里选"}</span>}</button>
        {p.part === FRONT ? <span className="nm">{FRONT}</span>
          : <><input value={p.part} maxLength={12} placeholder="部位名" aria-label="部位名" onChange={e => set({ parts: draft.parts.map((x, k) => k === i ? { ...x, part: e.target.value } : x) })} />
            <button type="button" className="lp-btn link" onClick={() => set({ parts: draft.parts.filter((_, k) => k !== i), noParts: [...new Set([...(draft.noParts ?? []), p.part])].slice(-32) })}>移除</button></>}
      </div>))}
      <div className="lp-part"><button type="button" className="pic" onClick={() => { set({ parts: [...draft.parts, { part: "新部位", pick: null }] }); setTab("全部"); setTarget({ kind: "part", index: draft.parts.length }); }}><span className="none add">＋ 加一个部位</span></button></div>
    </div>);
  const otherSettings = (<>
    <h4 className="lp-h">品类</h4>
    <div className="lp-catcard"><b>品类</b>
      <span className="lp-chips">{CATEGORIES.map(c => (
        <button type="button" key={c.id} className={"lp-chip" + (c.id === draft.category ? " on" : "")} onClick={() => c.id !== draft.category && onChange(withCategory(draft, materials, layout, c.id))}>
          {c.id === "workwear" ? "冲锋衣" : "其他衣服"}{c.id === materials.category && <small className="lp-muted">AI 判断</small>}</button>))}</span>
      <span className="why">{draft.category === materials.category ? draft.categoryWhy || "按衣服的样子判断：连帽或立领、前中拉链、防风外套" : "你选的品类，卖点和每张图已按它重排"}</span>
      <small className="lp-muted">{category.id === "workwear" ? "冲锋衣：卖点按销量靠前的冲锋衣来排，还会补竞品常讲、素材没写的卖点" : "其他衣服：只用素材里的卖点，不参考竞品"} · 换品类会重排卖点和每张图，颜色和衣服图不动</small></div>
    {materials.wear && <>
      <h4 className="lp-h">穿法 <small>定妆照、有人的主图和规格图模特都照这个穿</small></h4>
      <div className="lp-model"><div className="lp-chips">{WEARS.map(t => {
        const liner = t === "内胆" ? wearOf({ ...materials, wear: { ...materials.wear!, type: "内胆" } }, draft.main)?.liner : undefined, off = t === "内胆" && !liner;
        return (<label key={t} className={"lp-chip" + (wearType === t ? " on" : "") + (off ? " off" : "")} title={off ? "素材里没有外套里穿着内胆的照片" : ""}>
          <input type="radio" name="wear" hidden disabled={off} checked={wearType === t} onChange={() => set({ wear: t === "内胆" ? { type: t, liner } : t === "一体" ? { type: t, box: true } : { type: t } })} />{WEAR_LABEL[t]}</label>);
      })}</div>
        <p className="lp-say">{wearType === "内胆" ? <>外套敞开，里面穿着内胆，一眼看得出两层、厚实。{!linerByColor(draft) && <>内胆照这张素材画：{draft.wear?.liner && byLabel.get(draft.wear.liner) ? <a className="lp-liner-pic" href={byLabel.get(draft.wear.liner)!.url} target="_blank" rel="noreferrer" title={byLabel.get(draft.wear.liner)!.path}><img src={byLabel.get(draft.wear.liner)!.url} alt="" /></a> : draft.wear?.liner}</>}</>
          : wearType === "一体" ? (draft.wear?.open ? "拉链拉到顶、领子立起来，看着蓬松厚实；首图敞开穿，露出里面。" : "拉链拉到顶、领子立起来，看着蓬松厚实。") : "拉链拉到胸口，里面白 T，和以前一样。"}
          {materials.wear.why && <span className="lp-muted">（整理时看到：{materials.wear.why}）</span>}</p>
        {wearType === "内胆" && linerByColor(draft) && (() => {
          // 10-25: the cast and every main image wear the liner of the colour they show, as its SKU image does.
          const lined = (draft.versions ?? []).filter(v => v.on && v.kind === "外壳加内胆" && v.inner && v.colors.length);
          return (<div className="lp-main-liners">
            <span className="lp-small">定妆照和主图里每个颜色穿的内胆{lined.length > 1 && <> · 优先穿 <select value={lined.some(v => v.key === draft.wear?.main) ? draft.wear!.main : ""} onChange={e => set({ wear: { ...draft.wear!, main: e.target.value || undefined } })}>
              <option value="">素材里这个颜色最常搭的那件</option>{lined.map(v => <option key={v.key} value={v.key}>{linerName(v)}内胆</option>)}</select></>}：</span>
            {live(draft).map(c => {
              const m = mainLiner(linerImages, draft, c.name), img = m?.ref ? byLabel.get(m.ref) : undefined;
              return (<span key={c.name} className="lp-liner-tile" title={m?.ref && img ? img.path : ""}>{img ? <a href={img.url} target="_blank" rel="noreferrer"><img src={img.url} alt="" /></a> : <span className="none">拉链拉上</span>}
                <small><b>{c.name}</b> {m?.color && img ? `配${m.color}${linerName(m.version)}` : "看不到内胆"}</small></span>);
            })}
            <small className="lp-muted">要改某个颜色配哪件，在规格图下面「调整穿法」里改它的内胆颜色，主图跟着变。</small></div>);
        })()}</div>
    </>}
    {shops.length > 1 && <>
      <h4 className="lp-h">用哪套店铺 <small>左上角的店铺 LOGO、胸口的样例 LOGO、第 2 张服务图都用这套的；换色首图在第 ② 步还能另选</small></h4>
      <div className="lp-chips">{shops.map(s => (
        <button type="button" key={s.id} className={"lp-chip" + (shopState?.set === s.id ? " on" : "")} onClick={() => set({ shop: s.id })}>{s.name}{s.isDefault && <small> · 默认</small>}</button>))}</div>
    </>}
    <h4 className="lp-h">胸口印什么 <small>竞品首图几乎都在胸口印了标；只影响有人和整件衣服的主图，规格图不印</small></h4>
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
    {layout.sku.specCard && <>
      <h4 className="lp-h">规格图左边写什么 <small>用店铺设置里存的方案；这款单独换方案、改字，不影响别的款</small></h4>
      {/* 11-01: a dropdown and a picture of the left column with this product's own words (the chips were hard to read). */}
      <div className="lp-model lp-skuplan"><SkuLeftPreview rows={skuPreview.map(r => ({ label: r.label.split("/").pop()!, value: r.icon === "color" ? "（各颜色名）" : r.value }))} />
        <div>
        <label className="lp-small pick">方案 <select className="lp-in" value={skuSet.id} onChange={e => set({ skuFields: e.target.value })}>{[SKU_AUTO_SET, ...(shop?.skuFields.sets ?? [])].map(x => (
          <option key={x.id} value={x.id}>{x.id === SKU_AUTO ? "不指定（系统自动挑）" : x.name}{x.id === skuSetOf(shop?.skuFields).id ? " · 默认" : ""}</option>))}</select>
          <span className="lp-muted">方案在「店铺设置 → SKU 图左边写什么」里建</span></label>
        <div className="lp-skuwords">{skuWordFields.map(f => {
          const read = f === "style" ? styleNo(name) : skuFieldRows[f]?.value && !draft.skuWords?.[f]?.trim() ? skuFieldRows[f]!.value : null;
          const hint = f === "style" ? `不填会自动识别文件夹名最前面的货号${read ? `，现在认出「${read}」` : "，这款没认出来"}`
            : read ? `素材里读到「${read}」，要改就写` : "素材里没读到，可以手写；不写这一行就不放";
          return (<label key={f}><span>{skuFieldName(f)}</span>
            <input className="lp-in" value={draft.skuWords?.[f] ?? ""} maxLength={SKU_WORD_MAX} placeholder={hint}
              onChange={e => { const words = { ...draft.skuWords, [f]: e.target.value }; if (!e.target.value) delete words[f]; set({ skuWords: Object.keys(words).length ? words : undefined }); }} /></label>);
        })}</div>
        <p className="lp-say">左边就是这款规格图左边会写的字。{skuSet.id === SKU_AUTO ? "「不指定」时系统挑这款有的前两个，再加颜色。" : ""}{skuMissing.length ? <> <b>{skuMissing.map(skuFieldName).join("、")}</b>素材里没有字，这一行不放；在上面写上就有。</> : null}</p>
        </div>
      </div>
    </>}
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
  // ① 11-03: one block per question. On top, one line: can this go on (green) or what is missing (red). Then the colours
  // (which is the main one, which also get a cover of their own), then the SKU images as a table of what each one is drawn
  // from, then everything rarely changed folded into one line each.
  const extraOf = (color: string) => draft.extra.some(e => e.color === color);
  const toggleCover = (color: string) => set({ extra: extraOf(color) ? draft.extra.filter(e => e.color !== color) : [...draft.extra, { color, layout: "" }] });
  const pair = skuPair(layout), real = (draft.skuPeople ?? "实拍") === "实拍";
  /** The material's photo an SKU image would use as it is, or null when it is drawn. */
  const photoOf = (it: SkuItem) => real ? itemPhoto(materials.sorted.images, it, draft.model.lead, pair) : null;
  const versions = draft.versions ?? [], shellCols = versions.map((v, i) => ({ v, i })).filter(x => x.v.kind !== "单内胆");
  const alone = versions.map((v, i) => ({ v, i })).filter(x => x.v.kind === "单内胆");
  const keys = colorKeys(draft.colors);
  // A version with no colour ticked left is simply not made (11-03: unticking the last one used to turn the page red).
  const withColors = (colors: string[]): Partial<DraftVersion> => colors.length ? { on: true, colors } : { on: false, colors: [] };
  const toggleIn = (i: number, color: string) => {
    const v = versions[i], has = v.on && v.colors.includes(color);
    setVersion(i, withColors(has ? v.colors.filter(x => x !== color) : [...new Set([...(v.on ? v.colors : []), color])]));
  };
  /** 全选 (11-03): tick or untick every one of `names` in version i, a column of shell colours or a row of liners. */
  const setAllIn = (i: number, names: string[], tick: boolean) => {
    const v = versions[i], rest = v.on ? v.colors.filter(x => !names.includes(x)) : [];
    setVersion(i, withColors(tick ? [...new Set([...rest, ...names])] : rest));
  };
  const allBox = (i: number, names: string[], label: string) => {
    const v = versions[i], n = v.on ? names.filter(x => v.colors.includes(x)).length : 0, all = n > 0 && n === names.length;
    return <input type="checkbox" aria-label={`全选：${label}`} title={all ? "全部取消" : "全选"} checked={all} ref={el => { if (el) el.indeterminate = n > 0 && !all; }} onChange={() => setAllIn(i, names, !all)} />;
  };
  /** Every SKU image the table offers: each shell column's colours and each liner row's (the 全部勾上 / 全部取消 links). */
  const linerOptions = (v: DraftVersion) => [...new Set([...(materials.wear?.versions.find(x => x.kind === v.kind && x.inner === v.inner)?.colors ?? []), ...linerColors(materials.sorted.images, v.inner), ...v.colors])];
  const setEvery = (tick: boolean) => set({ versions: versions.map(v => {
    const names = v.kind === "单内胆" ? linerOptions(v) : live(draft).map(c => c.name);
    const rest = v.on ? v.colors.filter(x => !names.includes(x)) : [], colors = tick ? [...new Set([...rest, ...names])] : rest;
    return { ...v, ...withColors(colors) };
  }) });
  const skuCell = (it: SkuItem, on: boolean, ref: string | null, onClick?: () => void) => {
    const photo = photoOf(it), url = (photo && byLabel.get(photo)?.url) || (ref && byLabel.get(ref)?.url) || "";
    return (<button type="button" className={"lp-opt" + (photo ? "" : " draw") + (on ? "" : " off")} aria-pressed={on} aria-label={it.label} title={photo ? `用素材照片 ${photo}` : "素材里没拍到，AI 照定妆照里的模特画"} onClick={onClick} disabled={!onClick}>
      {url && <img src={url} alt="" loading="lazy" />}{!photo && <em>AI 画</em>}{onClick && <span className="ck" aria-hidden="true" />}</button>);
  };
  const skuAll = layout.sku.specCard ? skuItemsOf(draft) : [], mainItem = skuAll.find(i => i.name === draft.main), mainPhoto = mainItem ? photoOf(mainItem) : null;
  const exampleUrl = (mainPhoto && byLabel.get(mainPhoto)?.url) || (live(draft).find(c => c.name === draft.main)?.pick && byLabel.get(live(draft).find(c => c.name === draft.main)!.pick!)?.url) || "";
  const nReal = skuAll.filter(i => photos.has(i.key)).length, nDraw = skuAll.length - nReal;
  const wearSummary = wearType === "内胆" ? `三合一（${[...new Set(versions.filter(v => v.inner).map(v => linerName(v)))].join("、")}内胆）` : WEAR_LABEL[wearType];
  const logoText = logoMode === "不印" ? "不印" : logoMode === "LOGO" ? "印「LOGO」字样" : logoMode === "样例" ? "印样例 LOGO" : "印客户 LOGO";
  const step1 = (<>
    <div className={"lp-band " + (check.red.length ? "r" : "g")}>
      <span className="mark">{check.red.length ? "!" : "✓"}</span>
      <div className="txt">
        <b>{check.red.length ? `还差 ${check.red.length} 处，补好才能往下走` : "AI 已整理好素材，可以往下走"}</b>
        {check.red.length ? check.red.map(r => <small key={r}>· {r}</small>)
          : <span className="facts"><span>品类 <b>{category.id === "workwear" ? "冲锋衣" : "其他衣服"}</b></span><span>穿法 <b>{wearSummary}</b></span><span><b>{ok.length}</b> 个颜色</span><span>素材 <b>{library.length}</b> 张</span></span>}
        {audit.map(a => <small key={a.text} className="y">! {a.text}{a.fix && <> <button type="button" className="lp-btn sm" onClick={() => fixAudit(a.fix!)}>{a.fix.label}</button></>}</small>)}
      </div>
    </div>

    <section className="lp-q">
      <h4 className="lp-h2">有哪些颜色 <small>素材里认出 {draft.colors.length} 个颜色</small></h4>
      <p className="lp-qhelp">主推色出整套主图。想给别的颜色单独做一个链接，就勾它的「也出一张首图」。</p>
      <div className="lp-ccards">{draft.colors.map((c, i) => {
        const isMain = draft.main === c.name;
        return (
          <div key={i} className={"lp-ccard" + (isMain ? " main" : "") + (c.pick ? "" : " missing")}>
            <button type="button" className="pic" title="换一张" onClick={() => { setTab("推荐"); setTarget({ kind: "color", index: i }); }}>
              {c.pick ? pic(c.pick) : <span className="none">没找到「{c.name}」的衣服图<br /><b>点这里补</b></span>}</button>
            <input value={c.name} maxLength={12} aria-label="颜色名" onChange={e => { const nameNow = e.target.value; onChange(recolor({ ...draft, main: isMain ? nameNow : draft.main, colors: draft.colors.map((x, k) => k === i ? { ...x, name: nameNow } : x),
              slots: draft.slots.map(s => ({ ...s, colors: s.colors.map(n => n === c.name ? nameNow : n) })), extra: draft.extra.map(e2 => e2.color === c.name ? { ...e2, color: nameNow } : e2),
              versions: draft.versions?.map(v => ({ ...v, colors: v.kind === "单内胆" ? v.colors : v.colors.map(n => n === c.name ? nameNow : n) })) }, layout)); }} />
            {isMain ? <span className="mainpill">主推 · 出整套主图</span>
              : c.pick ? <button type="button" className="lp-btn link sm" onClick={() => onChange(recolor({ ...draft, main: c.name, extra: draft.extra.filter(e => e.color !== c.name), slots: draft.slots.map(s => s.colors.includes(c.name) ? { ...s, manual: false } : s) }, layout))}>设为主推</button> : <span />}
            <label className={"cvl" + (isMain || !c.pick ? " dis" : "")}><input type="checkbox" checked={isMain || extraOf(c.name)} disabled={isMain || !c.pick} onChange={() => toggleCover(c.name)} />{isMain ? "已有首图" : "也出一张首图"}</label>
            {!isMain && <button type="button" className="lp-btn link sm drop" onClick={() => { if (window.confirm(`去掉颜色「${c.name}」？这个颜色不出规格图，也不出现在主图里。`)) onChange(recolor({ ...draft, colors: draft.colors.filter((_, k) => k !== i), extra: draft.extra.filter(e => e.color !== c.name) }, layout)); }}>不要这个颜色</button>}
          </div>);
      })}</div>
    </section>

    {wearType === "一体" && (() => {
      // 10-29: each colour's inside, for the SKU images' small box and the open cover.
      const w = draft.wear!, insideOf = (i: number) => keys[i] ? insideFor(linerImages, draft, keys[i]!) : null;
      return (<section className="lp-q">
        <h4 className="lp-h2">衣服里面的照片 <small>翻开看到的里布、里绒、夹棉：规格图的小框放它，首图敞开时照它画</small></h4>
        <div className="lp-main-liners">{draft.colors.map((c, i) => {
          const label = insideOf(i), img = label ? byLabel.get(label) : undefined;
          return (<span key={i} className="lp-liner-tile" title={img?.path ?? ""}>
            <button type="button" className="lp-btn link" onClick={() => { setTab("推荐"); setTarget({ kind: "inside", index: i }); }}>{img ? <img src={img.url} alt="" /> : <span className="none">没有</span>}</button>
            <small><b>{c.name}</b> {label && <button type="button" className="lp-btn link" onClick={() => setInside(i, "")}>不用</button>}</small>
            {label && draft.colors.length > 1 && <button type="button" className="lp-btn link lp-small" onClick={() => insideAll(label)}>全部颜色用这张</button>}</span>);
        })}
          {layout.sku.specCard && <label className="lp-small" style={{ flexBasis: "100%" }}><input type="checkbox" checked={!!w.box} onChange={e => set({ wear: { ...w, box: e.target.checked } })} /> 规格图标题下放一个小框：有这个颜色里面的照片就放进去，没有就留一个空的灰框，自己 P 上</label>}
        </div>
      </section>);
    })()}

    {layout.sku.specCard && <section className="lp-q" id="lp-sku-versions">
      <h4 className="lp-h2">规格图（SKU 图） <small>买家选颜色、选款式时看到的图</small></h4>
      <div className="lp-skuintro">
        <div className="lp-skuex" aria-hidden="true"><SkuLeftPreview rows={skuPreview.map(r => ({ label: r.label.split("/").pop()!, value: r.icon === "color" ? draft.main : r.value }))} />{exampleUrl && <img src={exampleUrl} alt="" />}</div>
        <div>
          <p>商品页里，买家每点一个选项（比如「{draft.main}{shellCols.length > 1 ? ` · ${versionName(shellCols[1].v)}` : ""}」），就看到一张这样的图。左边的字、货号、颜色{wearType === "内胆" ? "和内胆小图" : ""}按模板排，不花钱；<b>右边的模特就是下面的一格</b>{versions.length ? "，勾上一格就出一张" : ""}。</p>
          <span className="key"><i className="sw photo" />实线框：素材里有这张照片，直接用，不花钱</span>
          <span className="key"><i className="sw draw" />虚线框：素材里没拍到，AI 照定妆照里的模特画{prices.exempt ? "" : `，每张 ${prices.image} 积分`}</span>
        </div>
      </div>
      {versions.length > 0 && <div className="lp-allbar"><span>全部规格图：</span><button type="button" className="lp-btn link" onClick={() => setEvery(true)}>全部勾上</button><button type="button" className="lp-btn link" onClick={() => setEvery(false)}>全部取消</button><small className="lp-muted">每列表头、每组内胆前的框是这一列（这一组）全选</small></div>}
      {shellCols.length > 0 ? <div className="lp-sx-scroll"><table className="lp-sx">
        <thead><tr><th className="rh">外套颜色</th>{shellCols.map(({ v, i }) => (
          <th key={v.key}><label className="colh">{allBox(i, live(draft).map(c => c.name), versionName(v))}
            {v.kind === "单外壳" ? "外套单穿" : <>外套里穿<br />{linerName(v)}内胆</>}</label></th>))}</tr></thead>
        <tbody>{live(draft).map(c => {
          const k = keys[draft.colors.indexOf(c)]!;
          return (<tr key={c.name}><th className="rh"><span className="rname">{c.pick && byLabel.get(c.pick) && <img src={byLabel.get(c.pick)!.url} alt="" />}{c.name}</span></th>
            {shellCols.map(({ v, i }) => <td key={v.key}>{skuCell({ key: `${k}~${v.key}`, color: k, name: c.name, version: v, label: `${c.name} · ${versionName(v)}` }, v.on && v.colors.includes(c.name), c.pick, () => toggleIn(i, c.name))}</td>)}</tr>);
        })}</tbody></table></div>
        : <div className="lp-lopts">{live(draft).map(c => { const k = keys[draft.colors.indexOf(c)]!; return <figure key={c.name} className="lp-lopt">{skuCell({ key: k, color: k, name: c.name, label: c.name }, true, c.pick)}<figcaption>{c.name}</figcaption></figure>; })}</div>}
      {alone.map(({ v, i }) => {
        const all = linerOptions(v);
        return (<div key={v.key} className="lp-lrow"><div className="h"><label className="colh">{allBox(i, all, `只卖${linerName(v)}内胆`)}<b>只卖{linerName(v)}内胆</b></label><small>内胆单独卖时的规格图</small></div>
          <div className="lp-lopts">{all.map((n, m) => (<figure key={n} className="lp-lopt">
            {skuCell({ key: `~${v.key}~${m}`, name: n, version: v, label: `${n} · ${versionName(v)}` }, v.on && v.colors.includes(n), linerAlone(linerImages, v.inner, n), () => toggleIn(i, n))}
            <figcaption>{n}{linerName(v)}</figcaption></figure>))}</div></div>);
      })}
      <div className="lp-eq"><span className="l">规格图</span><strong>{skuAll.length}</strong><span>张</span><span className="op">=</span><strong>{nReal}</strong><span>张用素材照片<small>不花钱</small></span><span className="op">+</span><strong>{nDraw}</strong><span>张 AI 画{!prices.exempt && <small>{nDraw * prices.image} 积分</small>}</span>
        {versions.length > 0 && !versions.some(v => v.on && v.colors.length) && <small className="lp-muted none">上面一格都没勾：每个颜色仍出一张最基本的规格图（外套单穿），买家选颜色时要有图</small>}</div>
      <div className="lp-who"><b>规格图里的人</b>
        <div className="lp-chips">{SKU_PEOPLE.map(p => (
          <label key={p} className={"lp-chip" + (skuBy === p ? " on" : "")}><input type="radio" name="skuPeople" hidden checked={skuBy === p} onChange={() => set({ skuPeople: p })} />
            {p === "实拍" ? <>素材照片优先 <small>推荐，省积分</small></> : `全部重画 · ${p === "男女" ? "男女一起" : p === "男" ? "男模特" : "女模特"}`}</label>))}</div>
        <small className="lp-muted">{skuBy === "实拍" ? `有照片的直接用，没照片的照定妆照画。${nReal && !prices.exempt ? `改成全部重画，人会更统一，但要多花 ${nReal * prices.image} 积分。` : ""}` : `全部照定妆照里的模特画，人统一。`}</small>
      </div>
      {versions.length > 0 && <details className="lp-fold">
        <summary><b>调整穿法</b><span>加一种穿法、改内胆名字、换某个颜色配的内胆</span></summary>
        <div className="in">{versionsEditor}</div>
      </details>}
    </section>}

    <details className="lp-fold">
      <summary><b>衣服结构图</b><span>{draft.parts.filter(p => p.pick).length} 张，AI 已配好；画衣服细节时照这些图</span></summary>
      <div className="in">
        <p className="lp-say">细节图只能拍这里有图的部位；部位名字可以改、加、删。</p>
        {partsGrid}
      </div>
    </details>
    <details className="lp-fold">
      <summary><b>其他设置</b><span>{category.id === "workwear" ? "冲锋衣" : "其他衣服"} · {WEAR_LABEL[wearType]}{shops.length > 1 ? ` · ${shops.find(s => s.id === shopState?.set)?.name ?? ""}` : ""} · 胸口{logoText} · 规格图左边{skuSet.id === SKU_AUTO ? "系统自动挑" : `用「${skuSet.name}」`}</span></summary>
      <div className="in">{otherSettings}</div>
    </details>
  </>);

  // ② 11-03: the chosen master large, its five samples; the others one small card each; who wears the cover and the
  // model side by side. The SKU images' people moved to ①, the counts and the extra covers to ④.
  const chosen = layouts.find(l => l.id === draft.layout) ?? rawLayout, chosenInfo = masterInfo(chosen.id);
  const pickLayout = (l: LayoutCard) => { if (l.id === draft.layout) return; const next = rearrange(draft, l, true); onChange(next); setMoved(movedNote(draft, next, l)); };
  const layoutStep = (<>
    {look && <p className="lp-say lp-ai">AI 看了素材，建议用<b>{layouts.find(l => l.id === look.master)?.name ?? look.master}</b>{look.place ? `，首图在${PLACES[look.place].name}拍` : ""}{look.sell ? `，主打「${look.sell}」` : ""}。{look.why}{look.why && !/[。！？]$/.test(look.why) ? "。" : ""}不合适直接点下面别的。</p>}
    <section className="lp-q">
      <div className="lp-chosen-h"><strong>{chosen.name}</strong>{look?.master === chosen.id && <span className="lp-chip-s ok">AI 建议</span>}<span>{chosen.description}</span></div>
      <div className="lp-chosen">{chosen.samples.map((src, i) => <figure key={src}><img src={src} alt="" loading="lazy" /><figcaption>{SAMPLE_CAPTION[i] ?? ""}</figcaption></figure>)}</div>
      <small className="lp-muted">适合：{chosenInfo.fit} · 字体：{chosenInfo.font} · {chosenInfo.cover === "实景" ? "首图实景，要选在哪儿拍" : chosenInfo.cover === "棚拍" ? "首图棚拍，不用选场景" : "首图无人，不用选场景"}</small>
    </section>
    <section className="lp-q">
      <h4 className="lp-h2">换一套母版 <small>点一下，上面的大图跟着换</small></h4>
      <div className="lp-others">{layouts.filter(l => !l.own && l.id !== draft.layout).map(l => (
        <button type="button" key={l.id} className="lp-mcard2" onClick={() => pickLayout(l)}>
          {l.samples[0] && <img src={l.samples[0]} alt="" loading="lazy" />}<b>{l.name}{look?.master === l.id && <span className="lp-chip-s ok">AI 建议</span>}</b><small>适合：{masterInfo(l.id).fit}</small></button>))}</div>
    </section>
    {masterInfo(layout.id).cover === "实景" ? <>
      <h4 className="lp-h2">首图在哪儿拍 <small>只影响首图（和 2:3 长图）的背景；天气和动作跟着第 ③ 步的首图卖点（防水就下雨）</small></h4>
      {moved && <div className="lp-alert y">{moved}</div>}
      <div className="lp-places">{PLACE_IDS.map(id => {
        const deny = masterInfo(layout.id).deny[id], here = draft.scene?.place === id;
        return (<button type="button" key={id} disabled={!!deny} className={"lp-pick lp-place" + (here ? " on" : "")}
          onClick={() => { const sell = draft.scene?.sell, fits = !!sell && (PLACES[id].fits as readonly string[]).includes(sell); onChange(withScene({ ...draft, scene: { place: id, sell: fits ? sell! : "" } }, layout)); setMoved(""); }}>
          <img src={PLACES[id].image} alt="" loading="lazy" /><b>{PLACES[id].name}</b>{deny && <small>{deny}</small>}</button>);
      })}</div>
    </> : <p className="lp-say">这套母版的首图是{masterInfo(layout.id).cover}的，不用选在哪儿拍。</p>}
    <div className="lp-two">
      <section className="lp-card2">
    {coverWho && <>
      <h4 className="lp-h2">首图谁来穿 <small>只管首图（和换色首图）；其它有人的图照母版自己的人数</small></h4>
      <div className="lp-model"><div className="lp-chips"><span className="lp-muted lp-small">人物</span>{COVER_PEOPLE.map(p => (
        <label key={p} className={"lp-chip" + (coverWho === p ? " on" : "")}><input type="radio" name="coverPeople" hidden checked={coverWho === p} onChange={() => set({ coverPeople: p })} />
          {p === "男女" ? "一男一女" : `单人 · ${p === "女" ? "女生" : "男生"}`}{p === coverDefault && <small> · 母版默认</small>}</label>))}</div>
        {wearType === "一体" && (() => {
          // 10-29, moved here 11-01: the cover worn open on its main colour's inside (photos chosen in step ①).
          const w = draft.wear!, mainAt = draft.colors.findIndex(c => c.name === draft.main), key = colorKeys(draft.colors)[mainAt];
          const mainInside = key ? insideFor(linerImages, draft, key) : null;
          return (<label className="lp-small">
            {/* No photo for the main colour: ticking it asks for one (10-29: a greyed box said nothing on 8826). */}
            <input type="checkbox" checked={!!w.open && !!mainInside} onChange={e => { if (e.target.checked && !mainInside && mainAt >= 0) { setTab("推荐"); setTarget({ kind: "inside", index: mainAt, open: true }); } else set({ wear: { ...w, open: e.target.checked } }); }} /> 首图敞开穿：一只手拉开一边，露出里面（照第 ① 步选的里面照片画），版式和字不变
            {!mainInside && <b> · 主推色「{draft.main}」还没有里面的照片，勾选时选一张</b>}
            {w.open && mainInside && <span className="lp-muted"> · {heatPoint(draft.points) ? "素材有发热保暖的卖点，里面加一个橙色发热小圆标" : "素材没有发热卖点，不加发热圆标"}</span>}</label>);
        })()}
        {coverWho === "男女" && rawLayout.templates.首图.square.people < 2 && <p className="lp-say">这套母版的首图本来是单人的，两个人也能出，但版式是按一个人排的，效果不保证和样图一样。</p>}
      </div>
    </>}
      </section>
      <section className="lp-card2">
    <h4 className="lp-h2">模特长相</h4>
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
      </section>
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
  // ③ 11-03: the images in a row to see what they say together; one image edited at a time; the points not on an image
  // as small chips by kind, a click puts one on the image being edited. The full list (to rename or take off) is folded.
  const curSlot = Math.min(cur, draft.slots.length - 1);
  const sampleOf = (s: Slot) => rawLayout.samples[s.shopService ? 1 : SAMPLE_OF[s.task] ?? 2];
  const strip = (<div className="lp-strip">{draft.slots.map((s, i) => {
    const k = used.indexOf(i), n = s.shopService ? 0 : notesOf(draft, i, layout).length, src = sampleOf(s);
    const words = s.shopService ? "用店铺存好的那张，不花钱" : [s.sub, ...s.cells.map(c => pointOf(c.point)?.text), ...s.tags].filter(Boolean).slice(0, 3).join(" · ");
    return (<button type="button" key={i} className={"lp-scard" + (i === curSlot ? " on" : "") + (k < 0 ? " off" : "")} aria-pressed={i === curSlot} onClick={() => setCur(i)}>
      <span className="no"><span>{k < 0 ? "这张不出" : `第 ${k + 1} 张`}</span><span>{s.shopService ? "服务" : TASK_LABEL[s.task]}</span></span>
      {src ? <img src={src} alt="" loading="lazy" /> : <span className="ph" />}<b>{s.title || "（没有大标题）"}</b>{words && <small>{words}</small>}{n > 0 && <small className="flag">! {n} 处要看一下</small>}</button>);
  })}</div>);
  const colourNames = new Set(draft.colors.map(c => c.name.trim()));
  const placedWords = new Set(draft.points.filter(p => usage.has(p.id)).flatMap(p => [p.text.trim(), (p.short ?? "").trim()]).filter(Boolean));
  const seenWords = new Set<string>();
  // Not on an image yet; a colour's name and a second copy of the same words are not points to place (11-03: 8828).
  const loose = own.filter(p => p.on && !usage.has(p.id) && !colourNames.has(p.text.trim()) && !placedWords.has(p.text.trim())).filter(p => {
    const k = (p.short || p.text).trim();
    if (seenWords.has(k) || seenWords.has(p.text.trim())) return false;
    seenWords.add(k); seenWords.add(p.text.trim()); return true;
  });
  const groupOfType = (t: string) => POOL_GROUPS.find(([, types]) => types.includes(t))?.[0] ?? "其他";
  const placeOn = (p: Point) => {
    const here = placesFor(draft, p.id, layout).filter(x => x.slot === curSlot), pick = here.find(x => x.empty) ?? here[0];
    if (pick) { change(putOn(draft, p.id, pick)); setPlacing(null); } else setPlacing({ id: p.id, all: true });
  };
  const chips = (
    <section className="lp-q">
      <h4 className="lp-h2">还没上图的卖点 <small>点一个，放到正在改的第 {Math.max(1, used.indexOf(curSlot) + 1)} 张上</small></h4>
      {loose.length ? <div className="lp-pgroups">{POOL_GROUPS.map(([g]) => g).concat("其他").filter((g, i, a) => a.indexOf(g) === i).map(g => {
        const list = loose.filter(p => groupOfType(p.type) === g);
        return list.length > 0 && (<div key={g} className="lp-pgroup"><span>{g}</span><div className="lp-chips">{list.map(p => (
          <span key={p.id} className="lp-chipwrap"><button type="button" className="lp-chip add" onClick={() => placeOn(p)}>＋ {p.text}</button>{placing?.id === p.id && placeMenu(p)}</span>))}</div></div>);
      })}</div> : <p className="lp-muted lp-small">素材里的卖点都上图了。</p>}
      {extras.length > 0 && <details className="lp-fold">
        <summary><b>竞品常讲、素材没写的</b><span>{extras.length} 条，衣服真有才放上去</span></summary>
        <div className="in"><div className="lp-pts">{extras.map(pointRow)}</div></div>
      </details>}
      <details className="lp-fold">
        <summary><b>全部卖点</b><span>改卖点的字、把卖点从图上拿下来</span></summary>
        <div className="in">{pool}</div>
      </details>
      <p className="lp-say">服务（免费设计、看样、开票这些）是店铺的，在<button type="button" className="lp-btn link" onClick={onService}>店铺设置</button>里写一次，每款第 2 张自动用店铺的服务图，这里不列。</p>
    </section>);
  const mapStep = (<div className="lp-map2">
    <section className="lp-q">
      <h4 className="lp-h2">{used.length} 张主图 <small>点一张，下面改它的字；版式照母版「{layout.name}」</small></h4>
      {strip}
    </section>
    {hint && <div className="lp-alert y lp-hint">按现在上图的卖点，可以{hint}。<button type="button" className="lp-btn sm" onClick={() => { if (window.confirm("按现在上图的卖点重排每张图？右边改过的标题和格子会重新排，颜色你选过的保留；拿下来的卖点不会再放回去。")) change(rearrange(draft, layout, false)); }}>按新卖点重排每张图</button></div>}
    <div className="lp-editor">{imageCard(curSlot)}</div>
    {chips}
      {draft.counts.long > 0 && <>
        <h4 className="lp-h">2:3 长图 <small>手淘推荐流里的竖版长图：{draft.counts.square > 0 ? "照 1:1 首图重排，字和字体都跟首图一样，人拉远、头部完整" : "人物完整、只有一行字，不放标签和格子"}</small></h4>
        <div className="lp-slot"><div className="who"><b>长图</b><Wire template={layout.long} ratio={2 / 3} width={84} /><small className="ppl">{PEOPLE_LABEL(layout.long)}</small></div><div className="lp-fields">
          {/* From the square cover (its words, word for word); only a set with no square images writes its own line. */}
          {draft.counts.square > 0 ? <><label>字</label><div className="lp-scene"><p>和首图一样：{[draft.slots[0]?.title, draft.slots[0]?.sub, ...(draft.slots[0]?.tags ?? [])].filter(Boolean).join(" / ")}。要改字，改上面的首图。</p></div></>
            : <><label>一行字</label><input className="big" value={draft.long.title} maxLength={LIMITS.title} onChange={e => change({ ...draft, long: { title: e.target.value } })} /></>}</div></div></>}
  </div>);
  // ④ 11-03: one big number, the counts here, and one row per kind of image (how many, made how, what it costs).
  type Row = { label: string; count: number; credits: number; how: string; fix?: () => void };
  const toSku = () => { setStep(1); setTimeout(() => document.getElementById("lp-sku-versions")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80); };
  const rowsOf = (lines: PriceLine[]): Row[] => {
    const out: Row[] = [];
    const main = lines.filter(l => l.label.startsWith("1:1 主图") || l.label === "店铺服务图（已存）");
    if (main.length) {
      const svc = main.filter(l => l.label === "店铺服务图（已存）").reduce((n, l) => n + l.count, 0), all = main.reduce((n, l) => n + l.count, 0);
      out.push({ label: "1:1 主图", count: all, credits: sumCredits(main), how: `${all - svc} 张要画${svc ? `；${svc} 张用店铺的服务图，不花钱` : ""}`, fix: () => setStep(3) });
    }
    const sku = lines.filter(l => l.label.startsWith("SKU"));
    if (sku.length) {
      const card = sku.find(l => l.label === "SKU 图"), drawn = sku.filter(l => l !== card).reduce((n, l) => n + l.count, 0), all = card?.count ?? drawn;
      out.push({ label: "规格图（SKU 图）", count: all, credits: sumCredits(sku), how: drawn ? `${Math.max(0, all - drawn)} 张用素材照片，${drawn} 张 AI 画` : "全部用素材照片拼，不花钱", fix: toSku });
    }
    for (const l of lines.filter(x => !main.includes(x) && !sku.includes(x))) {
      const label = l.label.replace("（多色同框）", ""), same = out.find(r => r.label === label);
      if (same) { same.count += l.count; same.credits += l.credits; } else out.push({ label, count: l.count, credits: l.credits, how: l.note });
    }
    return out;
  };
  const nowRows = rowsOf(cost.now.lines), laterRows = rowsOf(cost.later.lines);
  const nowImages = nowRows.reduce((n, r) => n + r.count, 0), laterImages = laterRows.reduce((n, r) => n + r.count, 0);
  const confirmStep = (
    <div className="lp-confirm5">
      <div className="lp-total">
        <div className="big"><span>这次出</span><strong>{nowImages}</strong><span>张图</span>{!prices.exempt && <><span>，约</span><strong>{cost.now.credits}</strong><span>积分</span><em>≈ ¥{(cost.now.credits / 100).toFixed(2)}</em></>}</div>
        <small>{prices.exempt ? "" : "先冻结积分，没出成功的自动退回。"}出图约 3–5 分钟，可以关掉页面，做好的会陆续出现。</small>
      </div>
      <section className="lp-q">
        <h4 className="lp-h2">出多少 <small>先出 1:1，满意了再出竖版，竖版照着改好的 1:1 重排</small></h4>
        <div className="lp-counts2">{([["square", "1:1 主图", 1, 5, "这次出"], ["portrait", "3:4 主图", 0, draft.counts.square, "1:1 满意后再出"], ["long", "2:3 长图", 0, 1, "1:1 满意后再出"]] as const).map(([key, label, min, max, when]) => (
          <div key={key} className="cnt"><b>{label}</b><span className="lp-stepper"><button type="button" aria-label={`${label}减少`} disabled={draft.counts[key] <= min} onClick={() => setCount(key, draft.counts[key] - 1)}>−</button><b>{draft.counts[key]}</b>
            <button type="button" aria-label={`${label}增加`} disabled={draft.counts[key] >= max} onClick={() => setCount(key, draft.counts[key] + 1)}>+</button></span><small>{when}</small></div>))}</div>
        {draft.extra.length > 0 ? <div className="lp-sets">{draft.extra.map((e, k) => (
          <div key={k} className="lp-set"><b>{e.color} 单独一张首图</b>
            版式 <select value={e.layout} onChange={x => set({ extra: draft.extra.map((y, m) => m === k ? { ...y, layout: x.target.value } : y) })}><option value="">跟主推一样</option>{layouts.filter(l => l.id !== draft.layout).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            {shops.length > 1 && <>店铺 <select value={e.shop ?? ""} onChange={x => set({ extra: draft.extra.map((y, m) => m === k ? { color: y.color, layout: y.layout, ...(x.target.value ? { shop: x.target.value } : {}) } : y) })}>
              <option value="">跟这款一样（{shops.find(s => s.id === shopState?.set)?.name}）</option>{shops.filter(s => s.id !== shopState?.set).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></>}
            <span className="grow">1:1 先出，3:4 跟竖版一起出</span><button type="button" className="lp-btn link" onClick={() => set({ extra: draft.extra.filter((_, m) => m !== k) })}>不要了</button></div>))}</div>
          : <small className="lp-muted">想给某个颜色单独出一张首图，在第 ① 步的颜色卡上勾「也出一张首图」。</small>}
      </section>
      <section className="lp-q">
        <h4 className="lp-h2">这次出的明细</h4>
        <div className="lp-sx-scroll"><table className="lp-tbl">
          <thead><tr><th>图</th><th className="n">张数</th><th>怎么来</th>{!prices.exempt && <th className="n">积分</th>}<th /></tr></thead>
          <tbody>{nowRows.map(r => <tr key={r.label}><td><b>{r.label}</b></td><td className="n">{r.count}</td><td className="how">{r.how}</td>{!prices.exempt && <td className="n">{r.credits}</td>}<td>{r.fix && <button type="button" className="lp-btn link" onClick={r.fix}>去改</button>}</td></tr>)}</tbody>
          <tfoot><tr><td><b>合计</b></td><td className="n">{nowImages}</td><td />{!prices.exempt && <td className="n">{cost.now.credits}</td>}<td /></tr></tfoot>
        </table></div>
        {laterImages > 0 && <small className="lp-muted">1:1 满意后再出：{laterRows.map(r => `${r.label} ${r.count} 张`).join("、")}{!prices.exempt && `，约 ${cost.later.credits} 积分`}；在出图结果里点「出竖版」。</small>}
        {check.warn.length > 0 && <small className="lp-warn">有提醒：{check.warn.map(k => <button type="button" key={k} className="lp-btn link" onClick={() => jump(k)}>第 {k} 张</button>)}</small>}
      </section>
    </div>);

  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan wide" role="dialog" aria-modal="true" aria-label="定方案">
        <div className="lp-box-head"><div><h3>定方案 · {name}</h3><p className="lp-sub">AI 已经整理好素材，下面每一项都是它的建议，不对的直接改。点「开始出图」之前不花钱。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-stepbar">{STEPS.map((s, i) => <button type="button" key={s} className={step === i + 1 ? "on" : i === 0 && check.red.length ? "bad" : i === 2 && check.warn.length ? "warn" : "ok"} onClick={() => go(i + 1)}>{s}</button>)}</div>
        <div className="lp-box-body" key={step}>{step === 1 ? step1 : step === 2 ? layoutStep : step === 3 ? mapStep : confirmStep}</div>
        <div className="lp-box-foot">
          <div className="grow">{check.red.length ? <span className="lp-bad">{check.red[0]}</span> : step === 4 ? <>母版 <b>{layout.name}</b> · 胸口{logoText}</> : <>现在出 <b>{nowImages}</b> 张图{!prices.exempt && <>，约 <b>{cost.now.credits}</b> 积分 <PriceInfo lines={cost.now.lines} total={cost.now.credits} extra="分析费已在整理时扣过" /></>}
            {laterImages > 0 && <span className="lp-muted"> · 竖版 {laterImages} 张以后再出{!prices.exempt && `，约 ${cost.later.credits} 积分`}</span>}
            {check.warn.length > 0 && <span className="lp-warn"> · 有提醒：{check.warn.map(k => <button type="button" key={k} className="lp-btn link" onClick={() => jump(k)}>第 {k} 张</button>)}</span>}</>}</div>
          {step > 1 && <button type="button" className="lp-btn" onClick={() => go(step - 1)}>上一步</button>}
          {step < 4 ? <button type="button" className="lp-btn primary" disabled={check.red.length > 0} onClick={() => go(step + 1)}>下一步</button>
            : <button type="button" className="lp-btn primary" disabled={busy || check.red.length > 0} onClick={async () => { setBusy(true); try { await onStart(); } finally { setBusy(false); } }}>{busy ? "正在开始…" : `开始出图${prices.exempt ? "" : ` · 约 ${cost.now.credits} 积分`}`}</button>}
        </div>
      </div>

      {linerOpen && <LinerDialog projectId={projectId} inner={linerOpen.inner} name={linerOpen.name} color={linerOpen.color} price={prices.exempt ? "" : `${prices.image} 积分`}
        candidates={linerImages.filter(i => i.inner === linerOpen.inner && !i.same && byLabel.has(i.id))
          .sort((a, b) => Number(b.role === "内胆") - Number(a.role === "内胆") || Number((b.innerColor || b.color) === linerOpen.color) - Number((a.innerColor || a.color) === linerOpen.color))
          .map(i => ({ label: i.id, url: byLabel.get(i.id)!.url, caption: i.role === "内胆" ? `${i.innerColor || i.color}单穿` : `${i.color}外套里的${i.innerColor ?? ""}` }))}
        onUpload={onUpload} onClose={() => setLinerOpen(null)}
        onDone={async (_label, color) => {
          const o = linerOpen;
          await onRefresh();
          if (o.version !== undefined && o.shell) { const v = draft.versions![o.version]; setVersion(o.version, { liners: { ...v.liners, [o.shell]: color } }); }
          setLinerOpen(null);
        }} />}
      {target && (
        <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) setTarget(null); }}>
          <div className="lp-box" role="dialog" aria-modal="true" aria-label="选一张图">
            <div className="lp-box-head"><div><h3>{target.kind === "inside" ? `选「${draft.colors[target.index]?.name ?? ""}」衣服里面的照片` : target.kind === "version" ? `选「${versionName(draft.versions![target.index])}」的参考图` : target.kind === "model" ? `选${GENDERS[target.index]}模特的照片` : target.kind === "color" ? `选「${draft.colors[target.index].name}」的衣服图` : `选结构图「${draft.parts[target.index]?.part ?? ""}」`}</h3>
              <p className="lp-sub">{target.kind === "inside" ? "挑一张翻开衣服、看得清里布或里绒的照片：SKU 图的小框放它，首图敞开时照它画里面。" : target.kind === "version" ? "挑一张能看清这个版本的图：外套里穿着这件内胆，或内胆单独穿。出图时照它画。" : target.kind === "model" ? "挑一张只有一个人、脸正面清楚、没戴墨镜口罩的。后面的图都照这个人画，照片里的衣服和背景不会带过去。" : target.kind === "color" ? "要衣服完整、正面、颜色准。推荐里是 AI 认为是这个颜色的图。" : draft.parts[target.index]?.part === FRONT ? "衣服完整的正面图" : `「${draft.parts[target.index]?.part ?? ""}」的特写，挑最清楚的一张；名字不对可以在外面改`}</p></div>
              <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={() => setTarget(null)}>关闭</button></div>
            <div className="lp-box-body">
              <div className="lp-tabs">{["推荐", "全部", ...KINDS].map(k => <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}</div>
              <div className="lp-lib">{shown.length ? shown.map(i => (
                <button type="button" key={i.label} className="it" onClick={() => assign(i.label)}><img src={i.url} alt="" loading="lazy" /><span className="cat">{sorted.get(i.label)?.kind}{sorted.get(i.label)?.color ? "·" + sorted.get(i.label)!.color : ""}</span><small>{i.path}</small></button>))
                : <span className="lp-muted">素材里没有推荐的图，可以看「全部」或补传一张。</span>}</div>
            </div>
            <div className="lp-box-foot"><div className="grow">{target.kind === "part" && draft.parts[target.index]?.part !== FRONT
              ? <button type="button" className="lp-btn link" onClick={() => { const gone = draft.parts[target.index]?.part; set({ parts: draft.parts.filter((_, k) => k !== target.index), ...(gone ? { noParts: [...new Set([...(draft.noParts ?? []), gone])].slice(-32) } : {}) }); setTarget(null); }}>移除这个部位（出图时不做特写）</button> : "素材里没有合适的？"}</div>
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

/** A liner's name on a version the user adds (10-28): one the material has, or any the user writes. */
function InnerPick({ value, names, onChange }: { value: string; names: string[]; onChange: (inner: string) => void }) {
  const [typing, setTyping] = useState(value ? !names.includes(value) : !names.length);
  if (typing) return <><input className="lp-in xs" value={value} maxLength={6} placeholder="如 软壳、摇粒绒" onChange={e => onChange(e.target.value.trim())} /><b>内胆</b></>;
  return (<select value={value} onChange={e => { if (e.target.value === "＋") { setTyping(true); onChange(""); } else onChange(e.target.value); }}>
    {names.map(n => <option key={n} value={n}>{n}内胆（素材里有）</option>)}<option value="＋">＋ 自己写一个…</option></select>);
}
