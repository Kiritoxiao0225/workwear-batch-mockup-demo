"use client";
/* eslint-disable @next/next/no-img-element -- service images come from the listing API */
/**
 * 电商主图 shop services: the services a shop offers, filled in once, and the service images made
 * from them — one per service layout and tone, kept and reused by every product. Changing a service
 * marks the kept images out of date; only the changed blocks are redrawn.
 *
 * Front end only for now: the shop lives in the browser and making an image is simulated with the
 * demo's real test images (or the layout's sample marked 演示占位).
 */
import { useEffect, useState } from "react";
import {
  blockedOf, CRAFTS, defaultShop, SERVICE_LAYOUTS, SERVICE_LIMITS, serviceLayout, staleOf, TONE_LABEL, wordsFor,
  type Craft, type SavedService, type ServiceCode, type ServiceItem, type ServiceLayout, type ShopService, type Tone,
} from "@/lib/listing/service";
import type { Slot } from "@/lib/listing/draft";

const KEY = "listing-shop-service";
/** What the demo's AI read in the materials: these come ticked. */
const FROM_MATERIALS = ["免费设计", "免费印绣", "一件起订", "现货速发", "三重质检"];
const sampleOf = (l: ServiceLayout, tone: Tone) => `/listing-demo/service/${l.samples[tone]}.jpg`;
/** Real test images the demo hands back as candidates; the rest are the sample, marked 演示占位. */
const DEMO_MADE: Partial<Record<string, string[]>> = { "A-dark": ["/listing-demo/service/A-dark-1.jpg"], "A-light": ["/listing-demo/service/A-light-1.jpg"] };

function loadShop(): ShopService {
  try { const s = localStorage.getItem(KEY); if (s) return JSON.parse(s) as ShopService; } catch { /* a fresh shop */ }
  return defaultShop(FROM_MATERIALS);
}
function saveShop(shop: ShopService) {
  try { localStorage.setItem(KEY, JSON.stringify(shop)); } catch { /* kept for this page only */ }
  window.dispatchEvent(new Event(KEY));
}
/** The shop's services, kept in step across the page. */
export function useShopService() {
  const [shop, setShop] = useState<ShopService | null>(null);
  useEffect(() => {
    const read = () => setShop(loadShop());
    read(); window.addEventListener(KEY, read);
    return () => window.removeEventListener(KEY, read);
  }, []);
  return shop;
}

type Making = { state: "making" } | { state: "choose"; candidates: { src: string; placeholder: boolean }[]; pick: number };

export function ServiceDialog({ unit, exempt, onClose, onSay }: { unit: number; exempt: boolean; onClose: () => void; onSay: (message: string) => void }) {
  const [shop, setShop] = useState<ShopService>(loadShop);
  const [tone, setTone] = useState<Record<ServiceCode, Tone>>({ A: "dark", B: "dark", C: "light", D: "light", E: "light" });
  const [making, setMaking] = useState<Partial<Record<string, Making>>>({});
  const change = (next: ShopService) => { setShop(next); saveShop(next); };
  const price = (n: number) => exempt ? "" : ` · 约 ${n * unit} 积分`;

  const setItem = (i: number, patch: Partial<ServiceItem>) => change({ ...shop, items: shop.items.map((x, m) => m === i ? { ...x, ...patch } : x) });
  const move = (i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= shop.items.length) return;
    const items = [...shop.items]; [items[i], items[j]] = [items[j], items[i]]; change({ ...shop, items });
  };
  const toggleCraft = (c: Craft) => change({ ...shop, crafts: shop.crafts.includes(c) ? shop.crafts.filter(x => x !== c) : [...shop.crafts, c] });
  const savedOf = (code: ServiceCode, t: Tone) => shop.saved.find(s => s.code === code && s.tone === t);

  const make = (l: ServiceLayout, t: Tone) => {
    const k = `${l.code}-${t}`;
    setMaking(m => ({ ...m, [k]: { state: "making" } }));
    setTimeout(() => {
      const real = DEMO_MADE[k] ?? [];
      const candidates = [...real.map(src => ({ src, placeholder: false })), ...Array.from({ length: Math.max(0, 2 - real.length) }, () => ({ src: sampleOf(l, t), placeholder: true }))];
      setMaking(m => ({ ...m, [k]: { state: "choose", candidates, pick: 0 } }));
    }, 2500);
  };
  const keep = (l: ServiceLayout, t: Tone) => {
    const k = `${l.code}-${t}`, m = making[k];
    if (m?.state !== "choose") return;
    const saved: SavedService = { code: l.code, tone: t, image: m.candidates[m.pick].src, words: wordsFor(l, shop), savedAt: new Date().toISOString() };
    change({ ...shop, saved: [...shop.saved.filter(s => !(s.code === l.code && s.tone === t)), saved] });
    setMaking(x => ({ ...x, [k]: undefined }));
    onSay(`已存下「${l.name}」（${TONE_LABEL[t]}），以后每款出图直接用，不再花钱`);
  };
  const redraw = (saved: SavedService, blocks: number[]) => {
    const k = `${saved.code}-${saved.tone}`;
    setMaking(m => ({ ...m, [k]: { state: "making" } }));
    setTimeout(() => {
      change({ ...shop, saved: shop.saved.map(s => s === saved ? { ...s, words: wordsFor(serviceLayout(s.code), shop), savedAt: new Date().toISOString() } : s) });
      setMaking(m => ({ ...m, [k]: undefined }));
      onSay(`重画了 ${blocks.length} 块字，其它地方没动`);
    }, 1500);
  };

  const card = (l: ServiceLayout) => {
    const t = tone[l.code], k = `${l.code}-${t}`, saved = savedOf(l.code, t), m = making[k];
    const words = wordsFor(l, shop), blocked = blockedOf(l, shop), stale = saved ? staleOf(saved, shop) : [];
    return (
      <div key={l.code} className={"lp-svc-card" + (stale.length ? " stale" : "")}>
        <div className="hd"><b>服务-{l.code} {l.name}</b>
          <span className="lp-seg">{(["dark", "light"] as Tone[]).map(x => <button type="button" key={x} className={t === x ? "on" : ""} onClick={() => setTone(o => ({ ...o, [l.code]: x }))}>{TONE_LABEL[x]}</button>)}</span></div>
        <p className="lp-sub">{l.what}</p>
        {m?.state === "choose" ? (
          <div className="pick">{m.candidates.map((c, n) => (
            <button type="button" key={n} className={"cand" + (m.pick === n ? " on" : "")} onClick={() => setMaking(x => ({ ...x, [k]: { ...m, pick: n } }))}>
              <img src={c.src} alt={`候选 ${n + 1}`} />{c.placeholder && <span className="ph">演示占位</span>}<span className="no">{n + 1}</span></button>))}</div>
        ) : (
          <div className="pic"><img src={saved?.image ?? sampleOf(l, t)} alt={l.name} />
            <span className={"badge" + (saved ? stale.length ? " y" : " g" : "")}>{saved ? stale.length ? `待更新：第 ${stale.map(i => i + 1).join("、")} 块字变了` : "已存 · 每款复用" : "样式示例"}</span>
            {m?.state === "making" && <div className="busy">生成中，约 1 分钟…</div>}</div>
        )}
        {l.kind !== "steps" && <ol className="words">{words.map((w, n) => { const [a, b] = w.split("｜"); return <li key={n} className={stale.includes(n) ? "chg" : ""}><b>{a}</b><small>{b}</small></li>; })}</ol>}
        {blocked && <p className="lp-warn">{blocked}</p>}
        {l.perProduct ? <p className="lp-muted lp-small">模特穿的是当前这一款，所以按款生成：在「定方案」的服务那一格选它，不在这里存。</p>
          : m?.state === "choose" ? <div className="acts"><button type="button" className="lp-btn sm primary" onClick={() => keep(l, t)}>存下第 {m.pick + 1} 张</button><button type="button" className="lp-btn sm" onClick={() => make(l, t)}>都不满意，再出 2 张{price(2)}</button></div>
          : <div className="acts">
            {saved && stale.length > 0 && <button type="button" className="lp-btn sm primary" disabled={m?.state === "making"} onClick={() => redraw(saved, stale)}>只重画变了的 {stale.length} 块{price(stale.length)}</button>}
            <button type="button" className={"lp-btn sm" + (saved ? "" : " primary")} disabled={!!blocked || m?.state === "making"} onClick={() => make(l, t)}>{saved ? "整张重出" : "生成"}（出 2 张挑 1 张{price(2)}）</button>
          </div>}
      </div>);
  };

  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-svc" role="dialog" aria-modal="true" aria-label="店铺服务">
        <div className="lp-box-head"><div><h3>店铺服务</h3><p className="lp-sub">只填一次。服务图照着竞品里做得好的服务图排版，只写你们自己的服务；存下来以后，每款出图直接用，不再花钱。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body lp-svc-body">
          <section>
            <h4 className="lp-h">① 你们提供哪些服务 <small>勾上的才会上图，排前面的先上；没勾的服务，图上一律不出现</small></h4>
            <div className="lp-svc-items">{shop.items.map((x, i) => (
              <div key={x.id} className={"row" + (x.on ? "" : " off")}>
                <input type="checkbox" checked={x.on} aria-label={`提供${x.title}`} onChange={e => setItem(i, { on: e.target.checked })} />
                <input className="t" value={x.title} maxLength={SERVICE_LIMITS.title} aria-label="服务名" onChange={e => setItem(i, { title: e.target.value })} />
                <input className="n" value={x.note} maxLength={SERVICE_LIMITS.note} aria-label="一句说明" onChange={e => setItem(i, { note: e.target.value })} />
                {x.ai && <span className="ai" title="整理素材时，AI 在你的图里读到了这项服务">素材里写了</span>}
                <span className="mv"><button type="button" aria-label="往前" disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button type="button" aria-label="往后" disabled={i === shop.items.length - 1} onClick={() => move(i, 1)}>↓</button></span>
              </div>))}
              <button type="button" className="lp-btn sm" onClick={() => change({ ...shop, items: [...shop.items, { id: `own-${Date.now()}`, title: "", note: "", on: true }] })}>＋ 自己加一条</button>
            </div>
            <p className="lp-muted lp-small">服务名最多 {SERVICE_LIMITS.title} 个字，说明最多 {SERVICE_LIMITS.note} 个字：图上的字越短越清楚。</p>
            <h4 className="lp-h">印绣工艺 <small>「印绣工艺」那张图用，选 3 种</small></h4>
            <div className="lp-chips">{CRAFTS.map(c => <button type="button" key={c} className={"lp-chip" + (shop.crafts.includes(c) ? " on" : "")} onClick={() => toggleCraft(c)}>{c}</button>)}</div>
            <h4 className="lp-h">样例 LOGO <small>工艺图和定制两步图上展示用；不传就写「LOGO」</small></h4>
            <label className="lp-svc-logo">{shop.logo ? <img src={shop.logo} alt="样例 LOGO" /> : <span>点这里上传</span>}
              <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => change({ ...shop, logo: String(r.result) }); r.readAsDataURL(f); }} /></label>
            <p className="lp-muted lp-small">用客户的真实 LOGO 做案例展示时，确认是真实合作或已获授权。</p>
          </section>
          <section>
            <h4 className="lp-h">② 服务图 <small>每种可选深色或浅色；出 2 张，自动核对图上的字，你挑一张存下</small></h4>
            <div className="lp-svc-cards">{SERVICE_LAYOUTS.map(card)}</div>
          </section>
        </div>
        <div className="lp-box-foot"><span className="grow">改了服务以后，已存的图会标「待更新」，旧图照常能用；重画只动变了的那几块字。</span><button type="button" className="lp-btn sm primary" onClick={onClose}>好了</button></div>
      </div>
    </div>
  );
}

/** The service image a slot uses: one of the shop's kept images, or "" to make it for this product. */
export function ServicePick({ value, onChange, onOpen }: { value: string; onChange: (value: string) => void; onOpen: () => void }) {
  const shop = useShopService();
  if (!shop) return null;
  const kept = shop.saved, chosen = kept.find(s => `${s.code}-${s.tone}` === value);
  return (
    <div className="lp-svc-pick">
      <label>服务图</label>
      <div>
        <select value={value} onChange={e => onChange(e.target.value)}>
          <option value="">按这款生成（下面的字）</option>
          {kept.map(s => <option key={`${s.code}-${s.tone}`} value={`${s.code}-${s.tone}`}>用店铺服务图：服务-{s.code} {serviceLayout(s.code).name}（{TONE_LABEL[s.tone]}）{staleOf(s, shop).length ? " · 待更新" : ""}</option>)}
        </select>
        {chosen ? <div className="kept"><img src={chosen.image} alt="" /><small>1:1 这张直接用店铺存好的，不花钱，也不用填字；字在「店铺服务」里改。3:4 竖版照常按它重排。</small></div>
          : <small className="lp-muted">{kept.length ? "选店铺存好的服务图，这张就不用再出。" : "店铺还没存服务图。"}<button type="button" className="lp-btn link" onClick={onOpen}>去店铺服务{kept.length ? "看看" : "设置"}</button></small>}
      </div>
    </div>
  );
}

/**
 * Above the images in 定方案: put the shop's kept service image in. The shop's services do not come
 * from this product's material, so any product can show it: it takes the 服务 image if the plan has
 * one, or goes in as the second image.
 */
export function ServiceBar({ slots, onSlots, onOpen }: { slots: Slot[]; onSlots: (slots: Slot[]) => void; onOpen: () => void }) {
  const shop = useShopService();
  if (!shop) return null;
  const at = slots.findIndex(s => s.task === "服务"), value = at >= 0 ? slots[at].shopService ?? "" : "";
  const pick = (v: string) => {
    if (at >= 0) {
      const s = slots[at];
      if (!v && s.why === KEPT_WHY) onSlots(slots.filter((_, i) => i !== at));
      else onSlots(slots.map((x, i) => i === at ? { ...x, shopService: v || undefined } : x));
    } else if (v) onSlots([slots[0], { task: "服务", lead: null, title: "店铺服务图", sub: "", tags: [], cells: [], act: null, colors: [], score: 50, why: KEPT_WHY, shopService: v }, ...slots.slice(1)]);
  };
  return (
    <div className="lp-svc-bar">
      <b>服务图</b>
      {shop.saved.length ? <select value={value} onChange={e => pick(e.target.value)}>
        <option value="">{at >= 0 ? "按这款生成（第 " + (at + 1) + " 张的字）" : "不放服务图"}</option>
        {shop.saved.map(s => <option key={`${s.code}-${s.tone}`} value={`${s.code}-${s.tone}`}>用店铺服务图：服务-{s.code} {serviceLayout(s.code).name}（{TONE_LABEL[s.tone]}）</option>)}
      </select> : <span className="lp-muted">店铺还没存服务图</span>}
      <small className="lp-muted">服务是店铺的，跟这款的素材无关；选了就放在第 2 张，1:1 不花钱。</small>
      <button type="button" className="lp-btn link" onClick={onOpen}>店铺服务</button>
    </div>
  );
}
const KEPT_WHY = "店铺服务图";

/** The kept service image in place of the slot's wireframe. */
export function KeptPreview({ value, width }: { value: string; width: number }) {
  const shop = useShopService();
  const kept = shop?.saved.find(s => `${s.code}-${s.tone}` === value);
  return kept ? <img className="lp-svc-prev" src={kept.image} alt="店铺服务图" style={{ width, height: width }} /> : null;
}
