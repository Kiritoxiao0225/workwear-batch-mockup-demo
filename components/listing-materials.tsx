"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图: confirming what the model sorted out of a raw product folder — one image per colour
 * (the only image the generator sees), the structure references, the selling points — plus the
 * price detail shown next to every credit amount.
 */
import { useRef, useState } from "react";

export const KINDS = ["颜色款图", "静物", "3D渲染", "模特实拍", "细节特写", "卖点图", "详情页", "海报", "尺码表", "无关"] as const;
export const PARTS = ["正面全身", "领口", "拉链和袖口", "口袋", "面料", "背面"] as const;
type Part = (typeof PARTS)[number];
export type Sorted = { id: string; kind: string; color: string; front: boolean; detail: string; text: boolean; logo: boolean; same: string };
export type Choice = { colors: { name: string; hex: string; pick: string | null }[]; parts: { part: Part; pick: string | null; skip: boolean }[]; points: { type: string; text: string; from: string[]; on: boolean }[] };
export type Materials = {
  sorted: { images: Sorted[]; colors: { name: string; hex: string; from: string[] }[]; points: { type: string; text: string; from: string[] }[]; notes: string[] };
  chosen: { colors: { name: string; hex: string; pick: string | null; candidates: string[] }[]; parts: { part: Part; pick: string | null; candidates: string[] }[] };
  duplicates: [string, string][]; images: { label: string; assetId: string }[]; choice?: Choice;
};
export type PriceLine = { label: string; count: number; unit: number; credits: number; note: string };

const WANT: Record<Part, string> = { 正面全身: "衣服完整的正面图", 领口: "领子的特写", 拉链和袖口: "拉链、袖口的特写", 口袋: "口袋的特写", 面料: "面料纹理或功能演示的特写", 背面: "衣服背面（背后有设计时建议补）" };
const AVOID: Record<Part, string> = { 正面全身: "", 领口: "出图时不特写领口", 拉链和袖口: "出图时不特写拉链和袖口", 口袋: "出图时不特写口袋", 面料: "出图时不做面料特写", 背面: "出图时不会出现背面角度" };

/** The program's picks as a starting choice; the ten most important points are ticked. */
export function defaultChoice(m: Materials): Choice {
  if (m.choice) return m.choice;
  return {
    colors: m.chosen.colors.map(c => ({ name: c.name, hex: c.hex, pick: c.pick })),
    parts: m.chosen.parts.map(p => ({ part: p.part, pick: p.pick, skip: false })),
    points: m.sorted.points.map((p, i) => ({ ...p, on: i < 10 })),
  };
}

/** red: cannot go on; yellow: suggestions left; green: ready. */
export function checkOf(choice: Choice): { level: "r" | "y" | "g"; text: string } {
  const noImage = choice.colors.filter(c => !c.pick).map(c => c.name);
  if (noImage.length) return { level: "r", text: `${noImage.join("、")} 没有衣服图，必须处理` };
  if (!choice.parts.find(p => p.part === "正面全身")?.pick) return { level: "r", text: "缺正面全身图，必须处理" };
  const open = choice.parts.filter(p => p.part !== "正面全身" && !p.pick && !p.skip).map(p => p.part);
  const on = choice.points.filter(p => p.on).length;
  const notes = [open.length ? `缺${open.join("、")}（可以补，也可以设为不需要）` : "", on < 3 ? `卖点只选了 ${on} 条` : ""].filter(Boolean);
  return notes.length ? { level: "y", text: notes.join("；") } : { level: "g", text: "素材齐了，可以直接继续" };
}

/** Confirming in bulk treats every suggestion left open as "not needed". */
export const settled = (choice: Choice): Choice => ({ ...choice, parts: choice.parts.map(p => p.part !== "正面全身" && !p.pick ? { ...p, skip: true } : p) });
export const payload = (choice: Choice) => ({ colors: choice.colors.map(c => ({ name: c.name.trim(), hex: c.hex, pick: c.pick })), parts: choice.parts, points: choice.points });

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

type Image = { label: string; url: string; path: string; sorted?: Sorted };
type Target = { kind: "color" | "part"; index: number } | null;

export function MaterialsDialog({ name, materials, paths, choice, onChange, onUpload, onClose, onConfirm }: {
  name: string; materials: Materials; paths: Map<string, string>; choice: Choice; onChange: (choice: Choice) => void;
  onUpload: (file: File) => Promise<{ label: string; url: string }>; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const sorted = new Map(materials.sorted.images.map(i => [i.id, i]));
  const images: Image[] = materials.images.map(i => ({ label: i.label, url: `/api/listing/assets/${i.assetId}`, path: paths.get(i.assetId) ?? i.label, sorted: sorted.get(i.label) }));
  const byLabel = new Map(images.map(i => [i.label, i]));
  const copies = [...materials.duplicates.map(([copy, keep]) => ({ copy, keep })), ...materials.sorted.images.filter(i => i.same).map(i => ({ copy: i.id, keep: i.same }))];
  const library = images.filter(i => !copies.some(c => c.copy === i.label));
  const [target, setTarget] = useState<Target>(null);
  const [tab, setTab] = useState("推荐");
  const [libTab, setLibTab] = useState("全部");
  const [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const check = checkOf(choice), on = choice.points.filter(p => p.on).length;
  const picked = new Set([...choice.colors.map(c => c.pick), ...choice.parts.map(p => p.pick), ...choice.points.filter(p => p.on).flatMap(p => p.from)].filter(Boolean)).size;
  const set = (patch: Partial<Choice>) => onChange({ ...choice, ...patch });
  const setColor = (i: number, patch: Partial<Choice["colors"][number]>) => set({ colors: choice.colors.map((c, k) => k === i ? { ...c, ...patch } : c) });
  const setPart = (i: number, patch: Partial<Choice["parts"][number]>) => set({ parts: choice.parts.map((p, k) => k === i ? { ...p, ...patch } : p) });
  const setPoint = (i: number, patch: Partial<Choice["points"][number]>) => set({ points: choice.points.map((p, k) => k === i ? { ...p, ...patch } : p) });
  const kindOf = (label: string | null) => (label && byLabel.get(label)?.sorted?.kind) || "补传";
  const candidates = (t: NonNullable<Target>) => {
    if (t.kind === "color") {
      const c = choice.colors[t.index], chosen = materials.chosen.colors.find(x => x.name === c.name)?.candidates ?? [];
      return library.filter(i => chosen.includes(i.label) || i.sorted?.color === c.name);
    }
    const part = choice.parts[t.index].part, chosen = materials.chosen.parts.find(x => x.part === part)?.candidates ?? [];
    return library.filter(i => chosen.includes(i.label) || (part !== "正面全身" && i.sorted?.kind === "细节特写"));
  };
  const assign = (label: string) => {
    if (!target) return;
    if (target.kind === "color") setColor(target.index, { pick: label }); else setPart(target.index, { pick: label, skip: false });
    setTarget(null);
  };
  const shown = target ? (tab === "推荐" ? candidates(target) : library.filter(i => tab === "全部" || i.sorted?.kind === tab)) : [];
  const card = (label: string, tag: string) => <div className="pic"><img src={byLabel.get(label)?.url} alt="" loading="lazy" /><span className="src">{tag}</span></div>;
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-mat" role="dialog" aria-modal="true" aria-label="确认素材和卖点">
        <div className="lp-box-head"><div><h3>确认素材和卖点 · {name}</h3>
          <p className="lp-sub">AI 已经把 {materials.images.length} 张素材整理好了：合并了 {copies.length} 张重复图，挑出 {picked} 张用来出图。看看对不对，不对的直接换。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <div className="lp-flow">上传 <b>{materials.images.length}</b> 张 → 合并重复 <b>{copies.length}</b> 张 → 整理 <b>{library.length}</b> 张 → 挑出 <b>{picked}</b> 张用来出图</div>
          <div className={"lp-alert " + (check.level === "r" ? "r" : check.level === "y" ? "y" : "g")}>{check.level === "g" ? "✓ " : "! "}{check.text}
            {materials.sorted.notes.length > 0 && <small>AI 的提醒：{materials.sorted.notes.join("；")}</small>}</div>

          <div className="lp-msec">
            <div className="lp-mhead"><span className="n">1</span><h4>每个颜色的衣服</h4><span className="tg r">必须</span><p>出图时只参考这里的图：每个颜色 1 张，要衣服完整（领口到下摆）、正面、颜色准、没被挡住。干净的静物图直接当白底图用，不收费。</p></div>
            <div className="lp-mcards">{choice.colors.map((c, i) => (
              <div key={i} className={"lp-mcard" + (c.pick ? "" : " missing")}>
                {c.pick ? card(c.pick, kindOf(c.pick)) : <div className="pic">缺这个颜色的衣服图<br /><br />素材里没有找到它的衣服图</div>}
                <div className="row"><span className="dotc" style={{ background: c.hex || "#999" }} /><input value={c.name} maxLength={12} onChange={e => setColor(i, { name: e.target.value })} /></div>
                <div className="row"><button type="button" className={"lp-btn sm" + (c.pick ? "" : " primary")} onClick={() => { setTab("推荐"); setTarget({ kind: "color", index: i }); }}>{c.pick ? "换一张" : "补传 / 选图"}</button>
                  <button type="button" className="lp-btn link" onClick={() => { if (window.confirm(`去掉颜色「${c.name}」？这个颜色不出 SKU 图，也不出现在主图里。`)) set({ colors: choice.colors.filter((_, k) => k !== i) }); }}>不要这个颜色</button></div>
              </div>))}
            </div>
          </div>

          <div className="lp-msec">
            <div className="lp-mhead"><span className="n">2</span><h4>衣服结构参考</h4><span className="tg y">建议齐全</span><p>AI 从这些图读出领型、拉链、口袋、袖口、面料，写进每张图的要求里；它们本身不会出现在生成的图里。</p></div>
            <div className="lp-mcards">{choice.parts.map((p, i) => (
              <div key={p.part} className={"lp-mcard" + (p.skip ? " skip" : p.pick ? "" : p.part === "正面全身" ? " missing" : " optional")}>
                {p.skip ? <div className="pic">不需要{p.part}<br /><br />{AVOID[p.part]}</div> : p.pick ? card(p.pick, kindOf(p.pick)) : <div className="pic">缺{p.part}<br /><br />{WANT[p.part]}</div>}
                <div className="lbl">{p.part}</div>
                <div className="row">{p.skip ? <button type="button" className="lp-btn link" onClick={() => setPart(i, { skip: false })}>改为需要</button> : <>
                  <button type="button" className="lp-btn sm" onClick={() => { setTab("推荐"); setTarget({ kind: "part", index: i }); }}>{p.pick ? "换一张" : "补传 / 选图"}</button>
                  {p.part !== "正面全身" && <button type="button" className="lp-btn link" onClick={() => setPart(i, { pick: null, skip: true })}>不需要</button>}</>}</div>
              </div>))}
            </div>
          </div>

          <div className="lp-msec">
            <div className="lp-mhead"><span className="n">3</span><h4>卖点</h4><span className="tg y">建议 6–10 条</span><p>从详情页、海报、做好的主图上的文字里读出来的，每条都标了出处。勾选的才会写进图里，可以改字，也可以自己加。</p></div>
            <div className="lp-points">{choice.points.map((p, i) => (
              <div key={i} className={"lp-pt" + (p.on ? "" : " off")}>
                <input type="checkbox" checked={p.on} onChange={e => setPoint(i, { on: e.target.checked })} aria-label="用这条" />
                <span className="ty">{p.type || "自己加"}</span>
                <input className="txt" value={p.text} maxLength={16} placeholder="写一条卖点" onChange={e => setPoint(i, { text: e.target.value })} />
                <span className="ev">{p.from.length ? <>出处{p.from.slice(0, 3).map(l => byLabel.get(l) && <img key={l} src={byLabel.get(l)!.url} title={byLabel.get(l)!.path} alt="" />)}</> : "你加的"}</span>
              </div>))}
            </div>
            <div><button type="button" className="lp-btn sm" onClick={() => set({ points: [...choice.points, { type: "", text: "", from: [], on: true }] })}>＋ 加一条卖点</button> <span className="lp-muted" style={{ fontSize: 13 }}>已选 {on} 条</span></div>
          </div>

          <details className="lp-all">
            <summary>全部素材：整理后 {library.length} 张 + 合并掉的重复 {copies.length} 张（点开按类别看）</summary>
            <div className="lp-tabs">{["全部", ...KINDS.filter(k => library.some(i => i.sorted?.kind === k)), "重复（已合并）"].map(k => (
              <button type="button" key={k} className={libTab === k ? "on" : ""} onClick={() => setLibTab(k)}>{k} {k === "全部" ? library.length : k === "重复（已合并）" ? copies.length : library.filter(i => i.sorted?.kind === k).length}</button>))}</div>
            {libTab === "重复（已合并）"
              ? <div className="lp-lib">{copies.map(c => byLabel.get(c.copy) && <a key={c.copy} className="it" href={byLabel.get(c.copy)!.url} target="_blank" rel="noreferrer"><img src={byLabel.get(c.copy)!.url} alt="" loading="lazy" /><span className="cat">同 {c.keep}</span><small>{byLabel.get(c.copy)!.path}</small></a>)}</div>
              : <div className="lp-lib">{library.filter(i => libTab === "全部" || i.sorted?.kind === libTab).map(i => (
                <a key={i.label} className="it" href={i.url} target="_blank" rel="noreferrer"><img src={i.url} alt="" loading="lazy" /><span className="cat">{i.sorted?.kind}{i.sorted?.color ? "·" + i.sorted.color : ""}</span><small>{i.path}</small></a>))}</div>}
          </details>
        </div>
        <div className="lp-box-foot">
          <div className="grow">{check.level === "r" ? <span className="lp-bad">{check.text}</span> : "确认后 AI 按挑出的图和勾选的卖点写每张图的内容（含在分析的积分里，不另收费）"}</div>
          <button type="button" className="lp-btn" onClick={onClose}>稍后再看</button>
          <button type="button" className="lp-btn primary" disabled={busy || check.level === "r"} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>确认，下一步写每张图的内容</button>
        </div>
      </div>

      {target && (
        <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) setTarget(null); }}>
          <div className="lp-box" role="dialog" aria-modal="true" aria-label="选一张图">
            <div className="lp-box-head"><div><h3>{target.kind === "color" ? `选「${choice.colors[target.index].name}」的衣服图` : `选结构参考「${choice.parts[target.index].part}」`}</h3>
              <p className="lp-sub">{target.kind === "color" ? "要衣服完整、正面、颜色准。推荐里是 AI 认为是这个颜色的图。" : WANT[choice.parts[target.index].part]}</p></div>
              <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={() => setTarget(null)}>关闭</button></div>
            <div className="lp-box-body">
              <div className="lp-tabs">{["推荐", "全部", ...KINDS].map(k => <button type="button" key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{k}</button>)}</div>
              <div className="lp-lib">{shown.length ? shown.map(i => (
                <button type="button" key={i.label} className="it" onClick={() => assign(i.label)}><img src={i.url} alt="" loading="lazy" /><span className="cat">{i.sorted?.kind}{i.sorted?.color ? "·" + i.sorted.color : ""}</span><small>{i.path}</small></button>))
                : <span className="lp-muted">素材里没有推荐的图，可以看「全部」或补传一张。</span>}</div>
            </div>
            <div className="lp-box-foot"><div className="grow">素材里没有合适的？</div>
              <button type="button" className="lp-btn" disabled={busy} onClick={() => upload.current?.click()}>{busy ? "正在上传…" : "补传一张"}</button>
              <input ref={upload} type="file" accept="image/*" hidden onChange={async e => {
                const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
                setBusy(true); try { const added = await onUpload(file); assign(added.label); } finally { setBusy(false); }
              }} /></div>
          </div>
        </div>)}
    </div>
  );
}
