"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图 results, in two rounds. Round one: the cast (the models every image with people is
 * drawn from), the 1:1 images, the SKU and white-background images. Clicking a main image opens
 * 「按要求修改」: say what to change (and add a reference image if wanted), the model redraws the
 * image from itself, and 「采用」 puts the result in its place; the old one stays in the history.
 * When the square images are right, 「出竖版」 makes the 3:4 images and the 2:3 long image from
 * the plan as the user left it. The cast can be redone, which redraws every image with people.
 */
import { useState } from "react";
import type { Detail, LayoutCard, SlotState } from "@/lib/listing/api-types";
import { assetUrl, downloadUrl, post, redrawImage } from "@/lib/listing/client-api";
import { TASK_LABEL } from "@/lib/listing/category";
import { colorKeys, SKU_PEOPLE, skuItemsOf, type SkuPeople } from "@/lib/listing/draft";
import { skuPhotos, skuWho } from "@/lib/listing/sku-card";
import { skuPair } from "@/lib/listing/templates";
import { EditDialog } from "./listing-edit";
import { draftPrice, layoutOf, PriceInfo, type Prices } from "./listing-plan";

const MAIN = /^(square|portrait|long):/;
const SHAPE: Record<string, string> = { square: "1 / 1", portrait: "3 / 4", long: "2 / 3", sku: "1 / 1", skumodel: "3 / 4", product: "1 / 1", cast: "3 / 4" };
const numOf = (slot: string) => slot.startsWith("long") ? "长图" : `第 ${slot.split(":")[1].split("+")[0]} 张`;

export function ResultsPanel({ detail, layouts, prices, onRedo, onDone, onError, onClose }: {
  detail: Detail; layouts: LayoutCard[]; prices: Prices;
  onRedo: (slot: string, label: string) => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void; onClose: () => void;
}) {
  const plan = detail.plan, layout = layoutOf(layouts, plan?.layout ?? detail.layout);
  const colors = plan?.colors.filter(c => c.pick) ?? [], main = plan?.main ?? "";
  // A SKU image by version is named for its colour and version (sku-versions.ts).
  const keys = colorKeys(colors), items = plan ? skuItemsOf(plan) : [], nameOf = (key: string) => items.find(i => i.key === key)?.label ?? colors[keys.indexOf(key)]?.name ?? key;
  const free = colors.filter(c => c.name !== main && !plan?.extra.some(e => e.color === c.name));
  const [adding, setAdding] = useState<{ color: string; layout: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** Versions made since the dialog opened: they show as new, not in the history. */
  const [fresh, setFresh] = useState<string[]>([]);
  const edit = (slot: string | null) => { setEditing(slot); setFresh([]); };
  const generating = detail.status === "generating";
  const made = detail.slots.filter(s => s.image).length;
  const later = plan && detail.materials ? draftPrice(plan, detail.materials, layout, prices).later : null;
  const people = detail.slots.filter(s => s.slot === "cast" || s.slot.startsWith("skumodel:") || (s.slot.startsWith("sku:") && layout.sku.people > 0) || (MAIN.test(s.slot) && s.task && layout.templates[s.task][s.slot.startsWith("portrait") ? "portrait" : "square"].people > 0) || (s.slot.startsWith("long") && layout.long.people > 0));
  const order = (slot: string) => `${["cast", "square", "portrait", "long", "sku", "skumodel", "product"].indexOf(slot.split(":")[0])}${slot.replace(/\d+/, n => n.padStart(2, "0"))}`;

  const taskOf = (s: SlotState) => s.task === "服务" ? "店铺服务图" : s.task ? TASK_LABEL[s.task] : "";
  const tile = (s: SlotState) => {
    const [kind, key] = s.slot.split(":"), wait = s.status === "queued" || s.status === "running", bad = !s.image && !wait;
    const label = kind === "cast" ? `模特定妆照${key ? ` · ${key}` : ""}` : kind === "sku" || kind === "skumodel" || kind === "product" ? nameOf(key) : `${numOf(s.slot)}${s.task ? ` · ${taskOf(s)}` : ""}${s.task !== "服务" && s.words?.title ? ` · ${s.words.title}` : ""}`;
    const version = s.history.findIndex(v => v.id === s.image) + 1, editable = MAIN.test(s.slot) && !!s.image;
    return (
      <div key={s.slot} className={"lp-out" + (bad ? " bad" : "") + (kind === "cast" ? " cast" : "")}>
        <div className="lp-out-img" style={{ aspectRatio: SHAPE[kind] }}>
          {s.image && (editable && !wait
            ? <button type="button" className="lp-out-open" title="按要求修改" onClick={() => edit(s.slot)}><img src={assetUrl(s.image)} alt={label} loading="lazy" /><span className="lp-out-tag">按要求修改</span></button>
            : <a href={assetUrl(s.image)} target="_blank" rel="noreferrer"><img src={assetUrl(s.image)} alt={label} loading="lazy" /></a>)}
          {s.history.length > 1 && version > 0 && <span className="lp-out-ver">第 {version} 版</span>}
          {wait && <span className="lp-out-wait">{s.status === "running" ? "出图中…" : "排队中"}</span>}
          {bad && <span className="lp-out-wait">没做出来</span>}
        </div>
        <b title={label}>{label}</b>
        {bad && s.error && <small className="lp-out-why">{s.error}</small>}
        {s.redraw?.status === "running" && <small className="lp-muted">正在按你说的改…</small>}
        {!wait && !editable && (kind !== "cast" || bad) && <button type="button" className="lp-btn sm" onClick={() => onRedo(s.slot, label)}>重新生成</button>}
      </div>);
  };
  const lane = (title: string, pick: (s: SlotState) => boolean, note = "", action?: React.ReactNode) => {
    const items = detail.slots.filter(pick).sort((a, b) => order(a.slot).localeCompare(order(b.slot)));
    return items.length ? <div className="lp-lane" key={title}><div className="lp-lane-label">{title}{note && <span className="lp-keep">{note}</span>}{action}</div><div className="lp-tiles">{items.map(tile)}</div></div> : null;
  };
  const sets = [...new Set(detail.slots.map(s => s.slot.split("+")[1]).filter(Boolean))];
  const act = async (path: string, body: unknown, message: string) => {
    setBusy(true);
    try { await post(`projects/${detail.id}/${path}`, body); await onDone(message); } catch (error) { onError((error as Error).message); } finally { setBusy(false); }
  };
  // Drawn from the material's photos the cast is a man and a woman drawn apart (both shown, both paid) and put together (free).
  const halves = detail.slots.some(s => s.slot.startsWith("cast:"));
  const recast = () => {
    const n = people.length + (halves ? 1 : 0);
    if (window.confirm(`${halves ? "重画模特：照素材里选的人重出定妆照" : "换一组模特：重出定妆照"}，并整张重画所有有人的图（共 ${n} 张${prices.exempt ? "" : `，约 ${n * prices.image} 积分`}）。改过的图也会整张重画，那些改动要重新做；旧版本都留着，可以换回。`)) void act("cast", {}, "开始换模特，有人的图会陆续重画");
  };
  const castSlot = detail.slots.find(s => s.slot === "cast");
  /**
   * 「全部重做」 the SKU images, showing whom the user picks: the material's own model photos (the colours
   * without one get the cover's people drawn), or the cast drawn in every colour. Drawn ones are paid, the cards free.
   */
  const redoSkus = (people: SkuPeople) => {
    const d = plan ? { colors, model: plan.model, skuPeople: people, versions: plan.versions } : null;
    const own = d && detail.materials ? Object.keys(skuPhotos(d, detail.materials.sorted.images, skuPair(layout))).length : 0;
    const n = (plan ? skuItemsOf(plan).length : colors.length) - own, by = d ? skuWho(d, skuPair(layout)) : "男女", who = by === "男女" ? "定妆照里的男女两位" : `定妆照里的${by === "男" ? "男生" : "女生"}`;
    const cost = n ? `（共 ${n} 张${prices.exempt ? "" : `，约 ${n * prices.image} 积分`}）` : "";
    const how = people === "实拍" ? `素材里有这个颜色模特图的直接用${n ? `，没有的 ${n} 个颜色照${who}重画${cost}` : ""}` : `每个颜色都照${who}重画${cost}`;
    if (window.confirm(`SKU 图全部重新生成：${how}，再按模板重新拼，所有颜色的人一样大。旧版本都留着。`)) void act("skus", { people }, "SKU 图开始重做，做好的会陆续换上");
  };
  const skuNow = plan?.skuPeople ?? "实拍";
  /** One redraw, waited for; the new version shows as new until the dialog closes. */
  const redraw = async (slot: string, ask: string, file: File | null) => {
    const made = await redrawImage(detail.id, slot, ask, file);
    setFresh(f => [...f, made.id]);
    void onDone("新图好了，满意就点「采用」");
    return made.url;
  };
  const edited = editing ? detail.slots.find(s => s.slot === editing && s.image) : undefined;
  const heavy: [string, () => void][] = generating ? [] : [
    ...(castSlot?.image ? [[halves ? "重画模特（有人的图全部重画）" : "换一组模特（有人的图全部重画）", recast] as [string, () => void]] : []),
    ...(layout.sku.specCard && detail.slots.some(s => s.slot.startsWith("sku:")) ? SKU_PEOPLE.map(p => [
      `SKU 图全部重新生成 · ${p === "实拍" ? "用素材实拍" : p === "男女" ? "男女模特一起" : `${p}模特`}${p === skuNow ? "（现在）" : ""}`, () => redoSkus(p)] as [string, () => void]) : []),
  ];
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan" role="dialog" aria-modal="true" aria-label="出好的图">
        <div className="lp-box-head"><div><h3>{generating ? "出图中" : detail.status === "square" ? "方图出好了" : "出好的图"} · {detail.name}</h3>
          <p className="lp-sub">{generating ? `做好 ${made}/${detail.slots.length} 张，关掉也会继续。` : `哪张主图不满意就点它：写想怎么改，可以加一张参考图，生成后点「采用」换上，原图留在历史里。${detail.status === "square" ? "改满意了，再出竖版。" : ""}`}</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          {detail.status === "square" && later && later.images > 0 && (
            <div className="lp-alert g lp-next">
              <div><b>下一步：出竖版</b>　3:4 主图 {plan!.counts.portrait} 张{plan!.counts.long ? " + 2:3 长图 1 张" : ""}，内容照现在的方图（包括你改过的），排版按竖图重新排{castSlot ? "，模特还是定妆照里的人" : ""}。
                <small>方图还要改的话，先改完再出；出完竖版以后改方图，竖版不会跟着变。</small></div>
              <button type="button" className="lp-btn primary" disabled={busy} onClick={() => void act("verticals", {}, "竖版开始出了，做好的会陆续出现")}>出竖版{prices.exempt ? "" : ` · 约 ${later.credits} 积分`}</button>
              {!prices.exempt && <PriceInfo lines={later.lines} total={later.credits} />}
            </div>)}
          {lane("模特定妆照", s => halves ? s.slot.startsWith("cast:") || (s.slot === "cast" && !s.image && s.status !== "queued" && s.status !== "running") : s.slot === "cast",
            halves ? "照素材里的模特画，后面有人的图都照这两位画" : "后面有人的图都照它画，是同一个人")}
          {lane(`主推套 · ${main} · 1:1 主图`, s => s.slot.startsWith("square:") && !s.slot.includes("+"), "点图可以按要求修改")}
          {lane(`主推套 · ${main} · 3:4 主图`, s => s.slot.startsWith("portrait:") && !s.slot.includes("+"), "讲的和 1:1 一样，按竖图重新排")}
          {lane("2:3 长图", s => s.slot.startsWith("long:") && !s.slot.includes("+"), "手淘推荐流用")}
          {sets.map(c => lane(`加的一套 · ${c}`, s => s.slot.endsWith("+" + c), "只换了首图，其余图和主推套共用"))}
          {lane("SKU 图", s => s.slot.startsWith("sku:"))}
          {lane("SKU 模特图", s => s.slot.startsWith("skumodel:"), "素材里没有这个颜色的模特图，照主模特画的；重新生成后 SKU 图跟着重拼")}
          {lane("白底产品图", s => s.slot.startsWith("product:"))}
        </div>
        {edited && <EditDialog title={`修改${numOf(edited.slot)} · ${taskOf(edited)}${edited.slot.startsWith("portrait") ? "（3:4）" : edited.slot.startsWith("long") ? "（2:3）" : ""}`}
          note={edited.task === "服务" ? "只改这一款的，店铺设置里存的服务图不变" : undefined}
          current={assetUrl(edited.image!)} price={prices.exempt ? "" : `${prices.image} 积分`}
          history={edited.history.filter(v => v.id !== edited.image && !fresh.includes(v.id)).map(v => ({ image: assetUrl(v.id), label: v.change ? `改：${v.change}` : `第 ${edited.history.indexOf(v) + 1} 版` }))}
          onGenerate={(ask, file) => redraw(edited.slot, ask, file)}
          onAdopt={image => { const v = edited.history.find(x => assetUrl(x.id) === image); if (v) void act("current", { slot: edited.slot, asset: v.id }, "换上了，原图在历史里").then(() => edit(null)); }}
          onClose={() => edit(null)} />}
        <div className="lp-box-foot">
          {adding ? <>
            <div className="grow">再加一套首图：颜色 <select value={adding.color} onChange={e => setAdding({ ...adding, color: e.target.value })}>{free.map(c => <option key={c.name}>{c.name}</option>)}</select>
              {" "}版式 <select value={adding.layout} onChange={e => setAdding({ ...adding, layout: e.target.value })}><option value="">跟主推套一样</option>{layouts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              {" "}{detail.status === "done" ? "1:1 首图 + 3:4 首图 + 长图" : "现在出 1:1 首图，竖版跟着出竖版一起出"}{prices.exempt ? "" : `，每张 ${prices.image} 积分`}</div>
            <button type="button" className="lp-btn" onClick={() => setAdding(null)}>取消</button>
            <button type="button" className="lp-btn primary" disabled={busy} onClick={() => void act("sets", adding, `「${adding.color}」的首图开始出了`).then(() => setAdding(null))}>开始出这一套</button>
          </> : <>
            {heavy.length > 0 && (
              <details className="lp-more">
                <summary className="lp-btn">更多操作</summary>
                <div className="lp-more-menu" role="menu">
                  {heavy.map(([name, run]) => <button type="button" role="menuitem" key={name} onClick={e => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; run(); }}>{name}</button>)}
                </div>
              </details>)}
            <div className="grow" />
            {free.length > 0 && !generating && <button type="button" className="lp-btn" onClick={() => setAdding({ color: free[0].name, layout: "" })}>＋ 再加一套首图（换颜色）</button>}
            {made > 0 && <a className="lp-btn primary" href={downloadUrl(detail.id)} onClick={e => { if (downloadUrl(detail.id).startsWith("#")) { e.preventDefault(); onError("演示页不能下载，上线后这里下载全部图"); } }}>下载这一款</a>}
          </>}
        </div>
      </div>
    </div>
  );
}
