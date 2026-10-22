"use client";
/* eslint-disable @next/next/no-img-element -- service images come from the listing API */
/**
 * 电商主图 shop settings: the services the shop offers, its own LOGO for the top-left corner of its main
 * images (lib/listing/corner.ts), its crafts and sample LOGO, and the four service images made from them. Confirming makes the images never made and redraws only the changed
 * words of the rest; each image can then be changed on its own (click it). The shop is kept on the
 * server (GET/POST shop, shop/make, shop/logo, shop/brand, shop/corner); its images are versions of the shop's own row, so
 * 「点图修改」 and 「采用」 work as on a product's images. Since 10-22 an account keeps several shops
 * (shop/sets): each has all of the above; one is the default, and a product's plan says which it uses.
 */
import { useEffect, useRef, useState } from "react";
import { api, post, redrawImage } from "@/lib/listing/client-api";
import {
  blockedOf, CRAFTS, MASTER_NAMES, pendingOf, SERVICE_IMAGES, SERVICE_LIBRARY, SERVICE_LIMITS, serviceSlot, SHOP_MAIN, staleOf, wordsFor,
  type Craft, type ServiceImageDef, type ServiceImageId, type ServiceItem, type ShopService, type ShopSet,
} from "@/lib/listing/service";
import { EditDialog } from "./listing-edit";

const KEY = "listing-shop-service-v2";
const EVENT = "listing-shop-changed";
const fmtDay = (iso: string) => { if (!iso) return ""; const d = new Date(iso); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/**
 * What the server says about one shop: its row (for redraws), which shop it is and the account's shops,
 * the settings and images, and what is being made.
 */
export type ShopState = { project: string; set: string; sets: ShopSet[]; shop: ShopService; making: ServiceImageId[]; failed: Partial<Record<ServiceImageId, string>> };
/** Each shop as last read, by its id; "" is the default shop. */
const cache = new Map<string, ShopState>(), loading = new Map<string, Promise<ShopState>>();
/** Keeps a shop as the server sent it (asked for as `key`); the list of shops on the others follows, and "" the default. */
const keep = (state: ShopState, key = state.set) => {
  const def = state.sets.find(s => s.isDefault)?.id;
  for (const [k, s] of [...cache]) {
    if (k && !state.sets.some(x => x.id === k)) cache.delete(k);
    else cache.set(k, { ...s, sets: state.sets });
  }
  if (cache.get("")?.set !== def) cache.delete("");
  cache.set(state.set, state); cache.set(key, state);
  if (state.set === def) cache.set("", state);
  window.dispatchEvent(new Event(EVENT));
  return state;
};
/** Reads a shop again ("": the default); every page part using it follows. */
export const reloadShop = (set = "") => {
  const run = loading.get(set) ?? api<ShopState>(set ? `shop?set=${encodeURIComponent(set)}` : "shop").then(s => keep(s, set)).finally(() => loading.delete(set));
  loading.set(set, run);
  return run;
};
/** A shop as the server has it, shared across the page; loaded once. None: the default one. */
export function useShopState(set?: string | null) {
  const key = set ?? "";
  const [state, setState] = useState<ShopState | null>(cache.get(key) ?? null);
  useEffect(() => {
    const read = () => { const s = cache.get(key); setState(s ?? null); if (!s) void reloadShop(key).catch(() => {}); };
    window.addEventListener(EVENT, read);
    read();
    return () => window.removeEventListener(EVENT, read);
  }, [key]);
  return state;
}
/** A shop's services and made images, or null while loading. */
export const useShopService = (set?: string | null) => useShopState(set)?.shop ?? null;
/** The account's shops (the default marked), or none while loading. */
export const useShopSets = () => useShopState()?.sets ?? [];

/** On the list of products, until the shop has its service images: one line and one action. */
export function ServiceTip({ onOpen }: { onOpen: () => void }) {
  const shop = useShopService();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    const read = () => { try { setHidden(localStorage.getItem(KEY + "-tip") === "later"); } catch { setHidden(false); } };
    read();
  }, []);
  if (!shop || hidden || Object.keys(shop.made).length) return null;
  return (
    <div className="lp-tip">
      <span className="ic">服</span>
      <div><b>先花 2 分钟写好店铺服务</b><p>免费设计、看样、开票这些写一次，点确认，每套母版的服务图一起出好，以后每款直接用。</p></div>
      <button type="button" className="lp-btn sm primary" onClick={onOpen}>去写</button>
      <button type="button" className="lp-btn sm ghost" onClick={() => { try { localStorage.setItem(KEY + "-tip", "later"); } catch { /* shown again next time */ } setHidden(true); }}>以后再说</button>
    </div>
  );
}

export function ShopPage({ unit, exempt, onSay }: { unit: number; exempt: boolean; onSay: (message: string) => void }) {
  const [picked, setPicked] = useState("");
  const state = useShopState(picked);
  if (!state) return <div className="lp-card lp-empty">正在读店铺设置…</div>;
  return <>
    {/* Switching shows the shop as last read, then as it is now (its images may have come out meanwhile). */}
    <ShopSets state={state} onPick={set => { setPicked(set); void reloadShop(set).catch(() => {}); }} onSay={onSay} />
    <ShopForm key={`${state.project}:${state.set}`} state={state} unit={unit} exempt={exempt} onSay={onSay} />
  </>;
}

/** A question asked on the page (not the browser's own box): a name to write, or a yes to an action that cannot be undone. */
type Ask = { title: string; note?: string; name?: string; ok: string; danger?: boolean; run: (name: string) => Promise<void> };
function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [name, setName] = useState(ask.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const naming = ask.name !== undefined, ready = !naming || !!name.trim();
  const go = async () => {
    if (!ready || busy) return;
    setBusy(true); setError("");
    try { await ask.run(name.trim()); onClose(); } catch (e) { setError((e as Error).message || "没成功，可以再试一次"); } finally { setBusy(false); }
  };
  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="lp-box lp-ask" role="dialog" aria-modal="true" aria-label={ask.title}>
        <div className="lp-box-body">
          <h3>{ask.title}</h3>
          {ask.note && <p className="lp-muted">{ask.note}</p>}
          {naming && <input className="lp-in" autoFocus value={name} maxLength={16} placeholder="比如：杭州旗舰店" aria-label="店铺名"
            onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void go(); if (e.key === "Escape" && !busy) onClose(); }} />}
          {error && <p className="lp-warn">{error}</p>}
        </div>
        <div className="lp-box-foot"><span className="grow">{naming ? `${name.trim().length} / 16 个字` : ""}</span>
          <button type="button" className="lp-btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className={"lp-btn " + (ask.danger ? "danger" : "primary")} disabled={busy || !ready} autoFocus={!naming} onClick={() => void go()}>{busy ? "稍等…" : ask.ok}</button></div>
      </div>
    </div>
  );
}

/** The account's shops (10-22): pick one to set up, add one, rename it, make it the default, delete it. */
function ShopSets({ state, onPick, onSay }: { state: ShopState; onPick: (set: string) => void; onSay: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const me = state.sets.find(s => s.id === state.set), several = state.sets.length > 1;
  const run = async (work: () => Promise<void>) => { setBusy(true); try { await work(); } catch (error) { onSay((error as Error).message); } finally { setBusy(false); } };
  const add = () => setAsk({ title: "新建一套店铺", note: "服务和工艺先照默认店铺填好；店铺 LOGO、样例 LOGO 和服务图要单独传、单独出。", name: "", ok: "新建",
    run: async name => { const s = keep(await post<ShopState>("shop/sets", { name })); onPick(s.set); onSay(`「${name}」建好了`); } });
  const rename = () => setAsk({ title: "店铺改名", name: me?.name ?? "", ok: "保存",
    run: async name => { if (name !== me?.name) keep(await post<ShopState>(`shop/sets/${state.set}`, { name })); } });
  const makeDefault = () => void run(async () => { keep(await post<ShopState>(`shop/sets/${state.set}`, { isDefault: true })); onSay(`「${me?.name}」设成默认了：之后新开的款默认用它`); });
  const remove = () => setAsk({ title: `删除「${me?.name}」？`, note: "这套店铺的 LOGO、服务和服务图都会删掉。已经出好的图不变；用它出图的款，以后左上角 LOGO 和重新生成都按默认店铺来。", ok: "删除", danger: true,
    run: async () => { keep(await api<ShopState>(`shop/sets/${state.set}`, { method: "DELETE" })); onPick(""); onSay("删掉了"); } });
  return (
    <div className="lp-card lp-shopsets">
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
      <div className="row">
        <b>店铺</b>
        <div className="lp-chips">{state.sets.map(s => (
          <button type="button" key={s.id} className={"lp-chip" + (s.id === state.set ? " on" : "")} onClick={() => onPick(s.id)}>{s.name}{several && s.isDefault && <small> · 默认</small>}</button>))}</div>
        <button type="button" className="lp-btn sm" disabled={busy || state.sets.length >= 10} onClick={add}>＋ 新建一套店铺</button>
        <span className="grow" />
        <button type="button" className="lp-btn link" disabled={busy} onClick={rename}>改名</button>
        {several && !me?.isDefault && <button type="button" className="lp-btn link" disabled={busy} onClick={makeDefault}>设为默认</button>}
        {several && !me?.isDefault && state.set !== SHOP_MAIN && <button type="button" className="lp-btn link danger" disabled={busy} onClick={remove}>删除</button>}
      </div>
      <p className="lp-muted lp-small">{several
        ? "每套店铺有自己的店铺 LOGO、服务、工艺、样例 LOGO 和服务图。新开的款默认用「默认」那套，方案第 ① 步可以换；换色首图和再出一套也能另选。"
        : "有几个店铺，就建几套：每套有自己的店铺 LOGO、服务、工艺、样例 LOGO 和服务图，出图时选用哪套。"}</p>
    </div>
  );
}

function ShopForm({ state, unit, exempt, onSay }: { state: ShopState; unit: number; exempt: boolean; onSay: (message: string) => void }) {
  // The services being edited stay on the page; the made images and what is being made come from the server.
  const [edits, setEdits] = useState<Pick<ShopService, "items" | "crafts">>({ items: state.shop.items, crafts: state.shop.crafts });
  const [editing, setEditing] = useState<ServiceImageId | null>(null);
  const [asking, setAsking] = useState(false);
  const fresh = useRef(new Map<string, string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shop: ShopService = { ...state.shop, ...edits }, making = state.making;
  const change = (next: ShopService) => {
    setEdits({ items: next.items, crafts: next.crafts });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void post<ShopState>("shop", { set: state.set, items: next.items, crafts: next.crafts }).then(s => keep(s)).catch(error => onSay((error as Error).message)); }, 600);
  };
  // While images are being made, the page asks again every few seconds.
  useEffect(() => {
    if (!making.length) return;
    const t = setInterval(() => void reloadShop(state.set).then(s => { if (!s.making.length) onSay(Object.keys(s.failed).length ? "有服务图没出成，没扣积分，可以再点确认" : "服务图出好了，以后每款出图按母版自动用"); }).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [making.length, onSay, state.set]);
  const credits = (n: number) => exempt ? "" : `约 ${n * unit} 积分`;
  const setCorner = (on: boolean) => void post<ShopState>("shop/corner", { on, set: state.set }).then(s => { keep(s); onSay(on ? "打开了：之后出的主图左上角放店铺 LOGO" : "关掉了：主图左上角不再放 LOGO"); }).catch(error => onSay((error as Error).message));

  const setItem = (i: number, patch: Partial<ServiceItem>) => change({ ...shop, items: shop.items.map((x, m) => m === i ? { ...x, ...patch } : x) });
  const move = (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= shop.items.length) return;
    const items = [...shop.items]; [items[i], items[j]] = [items[j], items[i]]; change({ ...shop, items });
  };
  const toggleCraft = (c: Craft) => {
    if (!shop.crafts.includes(c) && shop.crafts.length >= 3) { onSay("最多选 3 种工艺，先点掉一个"); return; }
    change({ ...shop, crafts: shop.crafts.includes(c) ? shop.crafts.filter(x => x !== c) : [...shop.crafts, c] });
  };

  const pending = pendingOf(shop), blocked = blockedOf(shop), newLogo = Object.values(shop.made).some(m => m?.oldLogo);
  const uploadLogo = (f: File) => void api<ShopState>("shop/logo", { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name), "x-shop-set": state.set } })
    .then(s => { keep(s); onSay(Object.values(s.shop.made).some(m => m?.oldLogo) ? "样例 LOGO 传好了：之后新开的款胸口默认印它；印绣工艺图点下面的「确认修改」重画" : "样例 LOGO 传好了：之后新开的款胸口默认印它，印绣工艺图也用它"); }).catch(error => onSay((error as Error).message));
  const [ask, setAsk] = useState<Ask | null>(null);
  const removeLogo = (which: "logo" | "brand") => setAsk({
    title: which === "logo" ? "删除样例 LOGO？" : "删除店铺 LOGO？", ok: "删除", danger: true,
    note: which === "logo" ? "之后出的图胸口改印「LOGO」字样（每款方案里也能改）；印绣工艺图要重画成抽象图案。" : "主图和 SKU 图左上角都不再放 LOGO，「放在左上角」会关掉。",
    run: async () => { keep(await api<ShopState>(`shop/${which}?set=${encodeURIComponent(state.set)}`, { method: "DELETE" })); onSay(which === "logo" ? "样例 LOGO 删掉了" : "店铺 LOGO 删掉了，左上角不再放"); },
  });
  // The cost: a new image is one image; redrawing the changed words of one is one image too.
  const confirm = async () => {
    setAsking(true);
    try {
      clearTimeout(saveTimer.current);
      keep(await post<ShopState>("shop", { ...edits, set: state.set }));
      await post("shop/make", { set: state.set });
      await reloadShop(state.set);
    } catch (error) { onSay((error as Error).message); } finally { setAsking(false); }
  };

  const bar = making.length
    ? <div className="lp-confirm-bar"><div><b>正在出服务图：还剩 {making.length} 张</b><small>约 1–2 分钟，可以离开页面</small></div></div>
    : !Object.keys(shop.made).length
      ? <div className="lp-confirm-bar"><div><b>服务写好了？点确认，4 张服务图一起出</b><small>5 套母版共用这 4 张；出好后每款出图直接用，不再花钱</small></div>
          <button type="button" className="lp-btn primary" disabled={!!blocked || asking} onClick={() => void confirm()}>确认，生成 4 张服务图{credits(4) && ` · ${credits(4)}`}</button>{blocked && <span className="lp-warn">{blocked}</span>}</div>
      : pending.images
        ? <div className="lp-confirm-bar y"><div><b>{newLogo && !pending.stale.length ? "你换了样例 LOGO，印绣工艺图要重画" : `你改了服务，${pending.images} 张服务图要更新`}</b>
            <small>{newLogo ? "印绣工艺图整张重画，换上新图案；" : ""}{pending.stale.length ? "其他的只重画变了的字；" : ""}没确认之前，旧图照常能用</small></div>
            <button type="button" className="lp-btn primary" disabled={!!blocked || asking} onClick={() => void confirm()}>确认修改{credits(pending.images) && ` · ${credits(pending.images)}`}</button>{blocked && <span className="lp-warn">{blocked}</span>}</div>
        : <div className="lp-confirm-bar ok"><div><b>4 张服务图都是最新的</b><small>改了服务、工艺或样例 LOGO 以后，这里会提示确认修改</small></div></div>;

  const card = (def: ServiceImageDef) => {
    const made = shop.made[def.id], busy = making.includes(def.id), stale = staleOf(def.id, shop), failed = state.failed[def.id];
    return (
      <figure key={def.id} className="lp-svc-img">
        {made && !busy
          ? <button type="button" className="pic" onClick={() => setEditing(def.id)} aria-label={`修改${def.name}`}><img src={made.image} alt={def.name} /><span className="edit-tag">点图修改</span>{made.oldLogo ? <span className="chip y">旧图案</span> : stale.length > 0 && <span className="chip y">旧字</span>}</button>
          : <div className={"pic empty" + (busy ? " busy" : "")}>{busy ? "生成中…" : failed ? "没出成，没扣积分" : "还没出"}</div>}
        <figcaption><b>{def.name}</b><small>用在：{def.masters.map(m => MASTER_NAMES[m]).join("、")}</small>
          {def.kind === "crafts" ? <div className="lp-crafts">
            <small>三格布面各做一种工艺，选 {def.slots} 种：</small>
            <div className="lp-chips">{CRAFTS.map(c => <button type="button" key={c} className={"lp-chip" + (shop.crafts.includes(c) ? " on" : "")} onClick={() => toggleCraft(c)}>{c}</button>)}</div>
            <small>布面上的图案：{shop.logo ? "上面传的样例 LOGO" : "抽象图案（上面传了样例 LOGO 就用它）"}</small>
          </div> : <small className="words">{wordsFor(def, shop).map(w => w.split("｜")[0]).join(" · ")}</small>}</figcaption>
      </figure>
    );
  };

  const shown = shop.items.filter(x => x.on).length, unused = shop.items.filter(x => !x.on && SERVICE_LIBRARY.some(l => l.id === x.id));
  const editDef = editing ? SERVICE_IMAGES.find(s => s.id === editing)! : null, editMade = editing ? shop.made[editing] : undefined;
  return (
    <div className="lp-shop">
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
      <div className="lp-shop-grid">
        <nav className="lp-snav" aria-label="店铺设置目录">
          <a href="#lp-s-svc">服务卖点</a><a href="#lp-s-brand">LOGO</a>
          <a href="#lp-s-img">服务图{pending.images > 0 && Object.keys(shop.made).length > 0 && <span className="chip y">{pending.images} 张旧字</span>}</a>
        </nav>
        <div>
          <section className="lp-ann" id="lp-s-svc">
            <div><h2>你们提供哪些服务</h2><p>勾上的才会上图，排在前面的先上。没勾的服务，图上一律不会出现。</p><p className="lp-small">服务名最多 {SERVICE_LIMITS.title} 个字，说明最多 {SERVICE_LIMITS.note} 个字，图上的字越短越清楚。</p></div>
            <div className="lp-card lp-svc-list">
              {shop.items.some(x => x.ai) && <p className="hint">从你上传过的商品图里读到 {shop.items.filter(x => x.ai).length} 条服务：{shop.items.filter(x => x.ai).map(x => x.title).join("、")}，已经帮你勾上了，不对就改。</p>}
              {shop.items.map((x, i) => (
                <div key={x.id} className={"row" + (x.on ? "" : " off")}>
                  <span className="mv"><button type="button" aria-label="往前" disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button type="button" aria-label="往后" disabled={i === shop.items.length - 1} onClick={() => move(i, 1)}>↓</button></span>
                  <input type="checkbox" checked={x.on} aria-label={`提供${x.title}`} onChange={e => setItem(i, { on: e.target.checked })} />
                  <input className="t" value={x.title} maxLength={SERVICE_LIMITS.title} aria-label="服务名" onChange={e => setItem(i, { title: e.target.value })} />
                  <input className="n" value={x.note} maxLength={SERVICE_LIMITS.note} aria-label="一句说明" onChange={e => setItem(i, { note: e.target.value })} />
                </div>))}
              <div className="more"><button type="button" className="lp-btn link" onClick={() => change({ ...shop, items: [...shop.items, { id: `own-${Math.max(0, ...shop.items.map(x => Number(x.id.replace(/^own-/, "")) || 0)) + 1}`, title: "", note: "", on: true }] })}>＋ 自己加一条</button>
                <span className="lp-muted lp-small">勾了 {shown} 条{unused.length ? `，还有 ${unused.length} 条常用服务没勾` : ""}</span></div>
            </div>
          </section>
          <section className="lp-ann" id="lp-s-brand">
            <div><h2>LOGO</h2><p>两个 LOGO，用处不一样：店铺 LOGO 是你们店的标，放在图的左上角；样例 LOGO 是印在衣服上做示范的标。</p><p className="lp-small">每款方案里胸口印什么还能改：样例 LOGO、这款单独传的客户 LOGO、「LOGO」字样或不印。</p></div>
            <div className="lp-logos">
            <div className="lp-card lp-pad">
              <h3>店铺 LOGO</h3>
              <p className="lp-muted lp-small">放在 1:1 和 3:4 主图的左上角，SKU 图左上角也用它；第 2 张服务图不放。不印到衣服上。</p>
              <div className="lp-logo-up"><label className="box">{shop.brand ? <img src={shop.brand} alt="店铺 LOGO" /> : <span>上传店铺 LOGO</span>}
                <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
                  void api<ShopState>("shop/brand", { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name), "x-shop-set": state.set } }).then(s => { keep(s); onSay(s.shop.corner ? "店铺 LOGO 换好了，留了位置的主图马上用新的" : "店铺 LOGO 传好了，选「放在左上角」就会用上"); }).catch(error => onSay((error as Error).message)); }} /></label>
                <div><p className="lp-muted lp-small">透明底 PNG 最好，横版更清楚；白底的会自动去掉白底。贴的时候按左上角的底色，自动用原色、白色或深色。</p>
                  {shop.brand && <p className="lp-small">点图换一张 · <button type="button" className="lp-btn link" onClick={() => removeLogo("brand")}>删除</button></p>}</div></div>
              <div className="lp-corner">{([[false, "不放", "主图照原样排，左上角不留位置"], [true, "放在左上角", shop.brand ? "之后出的主图在左上角留出位置，贴上这个 LOGO" : "先上传店铺 LOGO"]] as const).map(([on, name, what]) => (
                <button type="button" key={name} className={"lp-pick" + (shop.corner === on ? " on" : "")} disabled={on && !shop.brand} onClick={() => { if (shop.corner !== on) setCorner(on); }}><b>{name}</b><span>{what}</span></button>))}</div>
              <p className="lp-muted lp-small">打开以后新出的主图才留位置，之前出的图不贴。关掉或换 LOGO，留了位置的图马上跟着变，不用重出。</p>
            </div>
            <div className="lp-card lp-pad">
              <h3>样例 LOGO</h3>
              <p className="lp-muted lp-small">印在衣服上做示范，告诉买家能印标：每款方案的胸口默认印它；印绣工艺图三格布面上绣的、烫的、印的也是它。不传的话，胸口默认印「LOGO」字样，工艺图画抽象图案。</p>
              <div className="lp-logo-up"><label className="box">{shop.logo ? <img src={shop.logo} alt="样例 LOGO" /> : <span>上传样例 LOGO</span>}
                <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadLogo(f); }} /></label>
                <div><p className="lp-muted lp-small">传单独一个 LOGO，透明底 PNG 最好；不要传工艺效果拼图或产品照片，会被整张印到衣服上。用客户的真实 LOGO 做案例展示时，确认是真实合作或已获授权。</p>
                  {shop.logo && <p className="lp-small">点图换一张 · <button type="button" className="lp-btn link" onClick={() => removeLogo("logo")}>删除</button></p>}</div></div>
            </div>
            </div>
          </section>
          <section className="lp-ann" id="lp-s-img">
            <div><h2>服务图</h2><p>每套母版配好了一种服务图，颜色和风格跟那套图一致，5 套母版共用 4 张。</p><p className="lp-small">三张写的是上面勾的服务；印绣工艺那张的工艺在它下面直接选，布面图案用上面的样例 LOGO。</p><p className="lp-small">出商品时，用哪套母版就自动放对应的那张，放在第 2 张，不用选，也不再花钱。</p></div>
            <div className="lp-svc-imgs">
              {bar}
              <div className="grid">{SERVICE_IMAGES.map(card)}</div>
              {Object.keys(shop.made).length > 0 && <p className="lp-muted lp-small">哪张不满意，点它：写想怎么改，生成后点采用就换上，以后所有用这套母版的商品都用新的。</p>}
            </div>
          </section>
        </div>
      </div>
      {editDef && editMade && <EditDialog title={`修改服务图：${editDef.name}`} current={editMade.image} price={credits(1)}
        note="改好采用后，以后用这套母版的商品都用新的；已经出过图的商品不变"
        history={editMade.history.map(h => ({ image: h.image, label: fmtDay(h.madeAt) }))}
        onGenerate={async (ask, file) => { const made = await redrawImage(state.project, serviceSlot(editDef.id, state.set), ask, file); fresh.current.set(made.url, made.id); return made.url; }}
        onAdopt={image => {
          const asset = fresh.current.get(image) ?? editMade.history.find(h => h.image === image)?.asset;
          if (!asset) return;
          void post(`projects/${state.project}/current`, { slot: serviceSlot(editDef.id, state.set), asset }).then(() => reloadShop(state.set)).then(() => { setEditing(null); onSay("换上了，原图在历史里"); }).catch(error => onSay((error as Error).message));
        }}
        onClose={() => setEditing(null)} />}
    </div>
  );
}
