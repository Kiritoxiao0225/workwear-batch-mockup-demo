"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图 results, in two rounds. Round one: the cast (the models every image with people is
 * drawn from), the 1:1 images, the SKU and white-background images. Clicking a main image opens
 * 「按要求修改」: say what to change (and add a reference image if wanted), the model redraws the
 * image from itself, and 「采用」 puts the result in its place; the old one stays in the history.
 * When the square images are right, 「出竖版」 makes the 3:4 images and the 2:3 long image from
 * the plan as the user left it. The cast can be redone, which redraws every image with people.
 * A change is made in the background (10-25): several can be asked for one after another, and the
 * 「改图进度」 above the images lists each one until its new image is adopted or put away.
 */
import { SkuTextDialog, type SkuTextTarget } from "./listing-sku-text";
import { useState } from "react";
import type { Detail, LayoutCard, SlotState } from "@/lib/listing/api-types";
import { askRedraw, assetUrl, downloadUrl, post } from "@/lib/listing/client-api";
import { TASK_LABEL } from "@/lib/listing/category";
import { colorKeys, SKU_PEOPLE, skuItemsOf, type SkuPeople } from "@/lib/listing/draft";
import { skuPhotos, skuWho } from "@/lib/listing/sku-card";
import { skuPair, withCover } from "@/lib/listing/templates";
import { EditDialog } from "./listing-edit";
import { editTag, EditsBar, type EditItem } from "./listing-edits";
import { draftPrice, layoutOf, PriceInfo, type Prices } from "./listing-plan";
import { useShopSets } from "./listing-service";

const MAIN = /^(square|portrait|long):/;
const SHAPE: Record<string, string> = { square: "1 / 1", portrait: "3 / 4", long: "2 / 3", sku: "1 / 1", skumodel: "3 / 4", product: "1 / 1", cast: "3 / 4", liner: "1 / 1" };
/** How long until an image waiting to be tried again is tried: 「1 分钟」, or 「片刻」 when it is due. */
const retryIn = (at: string) => { const m = Math.ceil((Date.parse(at) - Date.now()) / 60_000); return m > 0 ? `${m} 分钟` : "片刻"; };
const numOf = (slot: string) => slot.startsWith("long") ? "长图" : `第 ${slot.split(":")[1].split("+")[0]} 张`;
const RATIO: Record<string, string> = { square: "1:1", portrait: "3:4", long: "2:3" };
/** Where a tile is on the page, for 「找到这张」. */
const tileId = (slot: string) => "lp-tile-" + slot.replace(/[^\w-]/g, "_");

export function ResultsPanel({ detail, layouts, prices, onRedo, onDone, onError, onClose }: {
  detail: Detail; layouts: LayoutCard[]; prices: Prices;
  onRedo: (slot: string, label: string) => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void; onClose: () => void;
}) {
  const plan = detail.plan, master = layoutOf(layouts, plan?.layout ?? detail.layout), layout = plan ? withCover(master, plan) : master;
  const colors = plan?.colors.filter(c => c.pick) ?? [], main = plan?.main ?? "";
  // A SKU image by version is named for its colour and version (sku-versions.ts).
  const keys = colorKeys(colors), items = plan ? skuItemsOf(plan) : [], nameOf = (key: string) => items.find(i => i.key === key)?.label ?? colors[keys.indexOf(key)]?.name ?? key;
  const free = colors.filter(c => c.name !== main && !plan?.extra.some(e => e.color === c.name));
  const [adding, setAdding] = useState<{ color: string; layout: string; shop?: string } | null>(null);
  // Another colour's cover may be for another shop (10-22); none: the product's.
  const shops = useShopSets(), ownShop = shops.find(s => s.id === plan?.shop) ?? shops.find(s => s.isDefault);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 「改 SKU 图文字」 (11-01): the whole product's or one image's words.
  const [skuText, setSkuText] = useState<SkuTextTarget | null>(null);
  const cardsDone = layout.sku.specCard && ["square", "done"].includes(detail.status), handWritten = plan?.skuEdits?.one ?? {};
  const edit = (slot: string | null) => setEditing(slot);
  /** Changes being sent (the reference image going up): tagged on the image until the server has them. */
  const [sending, setSending] = useState<string[]>([]);
  /** The tile 「找到这张」 points at, lit for a moment. */
  const [spot, setSpot] = useState<string | null>(null);
  const generating = detail.status === "generating";
  const made = detail.slots.filter(s => s.image).length;
  const later = plan && detail.materials ? draftPrice(plan, detail.materials, layout, prices).later : null;
  const people = detail.slots.filter(s => s.slot === "cast" || s.slot.startsWith("skumodel:") || (s.slot.startsWith("sku:") && layout.sku.people > 0) || (MAIN.test(s.slot) && s.task && layout.templates[s.task][s.slot.startsWith("portrait") ? "portrait" : "square"].people > 0) || (s.slot.startsWith("long") && layout.long.people > 0));
  const order = (slot: string) => `${["cast", "square", "portrait", "long", "sku", "skumodel", "liner", "product"].indexOf(slot.split(":")[0])}${slot.replace(/\d+/, n => n.padStart(2, "0"))}`;

  const taskOf = (s: SlotState) => s.task === "服务" ? "店铺服务图" : s.task ? TASK_LABEL[s.task] : "";
  const tile = (s: SlotState) => {
    const [kind, key] = s.slot.split(":"), wait = s.status === "queued" || s.status === "running", bad = !s.image && !wait;
    // A liner's thumbnail (11-04): 「黑色 · 羽绒内胆」 (key 羽绒~黑色), by the name the plan calls it.
    const [inner, ...tint] = kind === "liner" ? key.split("~") : [];
    const label = kind === "liner" ? `${tint.join("~")} · ${plan?.versions?.find(v => v.inner === inner)?.name || inner}内胆`
      : kind === "cast" ? `模特定妆照${key ? ` · ${key}` : ""}` : kind === "sku" || kind === "skumodel" || kind === "product" ? nameOf(key) : `${numOf(s.slot)}${s.task ? ` · ${taskOf(s)}` : ""}${s.task !== "服务" && s.words?.title ? ` · ${s.words.title}` : ""}`;
    const version = s.history.findIndex(v => v.id === s.image) + 1, editable = MAIN.test(s.slot) && !!s.image;
    const change = sending.includes(s.slot) ? { tone: "b", tag: "提交中…" } : s.redraw?.open ? editTag(s.redraw) : null;
    return (
      <div key={s.slot} id={tileId(s.slot)} className={"lp-out" + (bad ? " bad" : "") + (kind === "cast" ? " cast" : "") + (spot === s.slot ? " spot" : "")}>
        <div className="lp-out-img" style={{ aspectRatio: SHAPE[kind] }}>
          {s.image && (editable && !wait
            ? <button type="button" className="lp-out-open" title="按要求修改" onClick={() => edit(s.slot)}><img src={assetUrl(s.image)} alt={label} loading="lazy" /><span className="lp-out-tag">按要求修改</span></button>
            : <a href={assetUrl(s.image)} target="_blank" rel="noreferrer"><img src={assetUrl(s.image)} alt={label} loading="lazy" /></a>)}
          {s.history.length > 1 && version > 0 && <span className="lp-out-ver">第 {version} 版</span>}
          {wait && <span className="lp-out-wait">{s.status === "running" ? s.retries ? `第 ${s.retries + 1} 次出图中…` : "出图中…" : s.retries ? "等待自动重试" : "排队中"}</span>}
          {bad && <span className="lp-out-wait">没做出来</span>}
          {change && <span className={"lp-out-edit " + change.tone}>{change.tag}</span>}
        </div>
        <b title={label}>{label}</b>
        {bad && s.error && <small className="lp-out-why">{s.error}</small>}
        {wait && !!s.retries && <small className="lp-muted">上次没出来（{s.error ?? "出图失败"}），会自动再试，不扣费{s.status === "queued" && s.retryAt ? `，约 ${retryIn(s.retryAt)}后` : ""}</small>}
        {kind === "sku" && handWritten[key] && <small className="lp-keep">单独改过字</small>}
        {!wait && !editable && (kind !== "cast" || bad) && <button type="button" className="lp-btn sm" onClick={() => onRedo(s.slot, label)}>重新生成</button>}
        {kind === "sku" && cardsDone && s.image && !wait && <button type="button" className="lp-btn sm ghost" onClick={() => setSkuText({ mode: "one", key })}>只改这一张的文字</button>}
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
  /** One change, asked for: it is made in the background, its progress shows in 「改图进度」 and on the image. */
  const redraw = async (slot: string, ask: string, files: File[]) => {
    setSending(x => [...x, slot]);
    try {
      await askRedraw(detail.id, slot, ask, files);
      await onDone("已提交，在后台改：可以接着点别的图提要求，进度看上面的「改图进度」");
      return null;
    } catch (error) { onError(`${nameOfSlot(slot)}没提交上：${(error as Error).message}`); throw error; }
    finally { setSending(x => x.filter(y => y !== slot)); }
  };
  const nameOfSlot = (slot: string) => {
    const [kind, rest] = slot.split(":"), set = rest?.split("+")[1], s = detail.slots.find(x => x.slot === slot);
    return `${numOf(slot)} · ${RATIO[kind] ?? kind}${set ? ` · 加的一套 ${set}` : ""}${s?.task ? ` · ${taskOf(s)}` : ""}`;
  };
  const locate = (slot: string) => {
    document.getElementById(tileId(slot))?.scrollIntoView({ behavior: "smooth", block: "center" });
    setSpot(slot); setTimeout(() => setSpot(x => x === slot ? null : x), 2200);
  };
  // Every change still waiting for the user: being made first, then new images, then failures.
  const RANK = { queued: 0, running: 0, succeeded: 1, failed: 2 };
  const edits: EditItem[] = detail.slots.filter(s => s.image && s.redraw?.open).map(s => ({ slot: s.slot, label: nameOfSlot(s.slot), redraw: s.redraw!,
    image: assetUrl(s.redraw!.status === "succeeded" && s.redraw!.asset ? s.redraw!.asset : s.image!) }))
    .sort((a, b) => RANK[a.redraw.status] - RANK[b.redraw.status] || (a.redraw.at ?? "").localeCompare(b.redraw.at ?? ""));
  const keepShown = (slot: string, message: string) => { const s = detail.slots.find(x => x.slot === slot); if (s?.image) void act("current", { slot, asset: s.image }, message); };
  const edited = editing ? detail.slots.find(s => s.slot === editing && s.image) : undefined;
  const editedNew = edited?.redraw?.open && edited.redraw.status === "succeeded" ? edited.redraw.asset : undefined;
  const heavy: [string, () => void][] = generating ? [] : [
    ...(castSlot?.image ? [[halves ? "重画模特（有人的图全部重画）" : "换一组模特（有人的图全部重画）", recast] as [string, () => void]] : []),
    // Free (10-26): the cards put together again, the shop's badge and LOGO as they are now; nobody redrawn.
    ...(layout.sku.specCard && detail.slots.some(s => s.slot.startsWith("sku:") && s.image) ? [["按店铺设置重拼 SKU 图（免费，不重画模特）", () => void act("recard", {}, "SKU 图开始重拼，用的是店铺设置里现在的角标和 LOGO")] as [string, () => void]] : []),
    ...(layout.sku.specCard && detail.slots.some(s => s.slot.startsWith("sku:")) ? SKU_PEOPLE.map(p => [
      `SKU 图全部重新生成 · ${p === "实拍" ? "用素材实拍" : p === "男女" ? "男女模特一起" : `${p}模特`}${p === skuNow ? "（现在）" : ""}`, () => redoSkus(p)] as [string, () => void]) : []),
  ];
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-plan" role="dialog" aria-modal="true" aria-label="出好的图">
        <div className="lp-box-head"><div><h3>{generating ? "出图中" : detail.status === "square" ? "方图出好了" : "出好的图"} · {detail.name}</h3>
          <p className="lp-sub">{generating ? `做好 ${made}/${detail.slots.length} 张，关掉也会继续；网络或出图通道出问题的会自动重试，直到出来或点「停止出图」。` : `哪张主图不满意就点它：写想怎么改，可以加一张参考图，生成后点「采用」换上，原图留在历史里。${detail.status === "square" ? "改满意了，再出竖版。" : ""}`}</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <EditsBar items={edits} busy={busy} onLocate={locate} onOpen={edit}
            onAdopt={i => void act("current", { slot: i.slot, asset: i.redraw.asset }, "换上了，原图在历史里")}
            onKeep={i => keepShown(i.slot, i.redraw.status === "succeeded" ? "保留了原来那张，新图在历史里" : "好的，这条收起了")} />
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
          {lane("SKU 图", s => s.slot.startsWith("sku:"), "", cardsDone && detail.slots.some(s => s.slot.startsWith("sku:") && s.image)
            ? <button type="button" className="lp-btn sm" onClick={() => setSkuText({ mode: "all" })}>改 SKU 图文字</button> : undefined)}
          {lane("SKU 模特图", s => s.slot.startsWith("skumodel:"), "素材里没有这个颜色的模特图，照主模特画的；重新生成后 SKU 图跟着重拼")}
          {lane("SKU 小框里的内胆", s => s.slot.startsWith("liner:"), "从素材里这件内胆的照片整理成白底；不满意点重新生成（不扣费），SKU 图跟着重拼")}
          {lane("白底产品图", s => s.slot.startsWith("product:"))}
        </div>
        {skuText && <SkuTextDialog projectId={detail.id} name={detail.name} target={skuText} onSaved={m => void onDone(m)} onError={onError} onClose={() => setSkuText(null)} />}
        {edited && <EditDialog title={`修改${numOf(edited.slot)} · ${taskOf(edited)}${edited.slot.startsWith("portrait") ? "（3:4）" : edited.slot.startsWith("long") ? "（2:3）" : ""}`}
          note={edited.task === "服务" ? "只改这一款的，店铺设置里存的服务图不变" : undefined}
          current={assetUrl(edited.image!)} price={prices.exempt ? "" : `${prices.image} 积分`}
          history={edited.history.filter(v => v.id !== edited.image && v.id !== editedNew).map(v => ({ image: assetUrl(v.id), label: v.change ? `改：${v.change}` : `第 ${edited.history.indexOf(v) + 1} 版` }))}
          background job={edited.redraw} made={editedNew ? [assetUrl(editedNew)] : []}
          initialAsk={edited.redraw?.open && edited.redraw.status === "failed" ? edited.redraw.ask : ""}
          onGenerate={(ask, files) => redraw(edited.slot, ask, files)}
          onAdopt={image => { const v = edited.history.find(x => assetUrl(x.id) === image); if (v) void act("current", { slot: edited.slot, asset: v.id }, "换上了，原图在历史里").then(() => edit(null)); }}
          onKeep={() => keepShown(edited.slot, edited.redraw?.status === "succeeded" ? "保留了原来那张，新图在历史里" : "好的，这条收起了")}
          onClose={() => edit(null)} />}
        <div className="lp-box-foot">
          {adding ? <>
            <div className="grow">再加一套首图：颜色 <select value={adding.color} onChange={e => setAdding({ ...adding, color: e.target.value })}>{free.map(c => <option key={c.name}>{c.name}</option>)}</select>
              {" "}版式 <select value={adding.layout} onChange={e => setAdding({ ...adding, layout: e.target.value })}><option value="">跟主推套一样</option>{layouts.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              {shops.length > 1 && <>{" "}店铺 <select value={adding.shop ?? ""} onChange={e => setAdding({ color: adding.color, layout: adding.layout, ...(e.target.value ? { shop: e.target.value } : {}) })}>
                <option value="">跟这款一样（{ownShop?.name}）</option>{shops.filter(s => s.id !== ownShop?.id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></>}
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
            {generating && <button type="button" className="lp-btn" disabled={busy} onClick={() => { if (window.confirm("停止出图：还没出的图都不出了，冻结的积分退回；正在出的那几张会出完。之后可以单张重新生成。")) void act("stop", {}, "已停止，没出的图不扣费"); }}>停止出图</button>}
            {free.length > 0 && !generating && <button type="button" className="lp-btn" onClick={() => setAdding({ color: free[0].name, layout: "" })}>＋ 再加一套首图（换颜色）</button>}
            {made > 0 && <a className="lp-btn primary" href={downloadUrl(detail.id)} onClick={e => { if (downloadUrl(detail.id).startsWith("#")) { e.preventDefault(); onError("演示页不能下载，上线后这里下载全部图"); } }}>下载这一款</a>}
          </>}
        </div>
      </div>
    </div>
  );
}
