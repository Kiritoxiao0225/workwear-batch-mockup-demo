"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 画板: change one finished main image a piece at a time. The things on the image — the words,
 * each card, the models, whatever the model added on its own — are listed and outlined where they
 * really are (found on the image after it was made; the layout's boxes are only a fallback). Pick
 * one from the list or on the image (clicking again goes to the one underneath) and give it other
 * words, another point or way of drawing; draw a box and say what goes there; or move a piece.
 * Only that box is redrawn and pasted back, the rest stays pixel for pixel; every change is a new
 * version. Changes on a square image go into the plan the 3:4 images are written from.
 */
import { useEffect, useRef, useState } from "react";
import type { CanvasEdit, Detail, Element, SlotState, Words } from "@/lib/listing/api-types";
import { assetUrl, post } from "@/lib/listing/client-api";
import { categoryById, TASK_LABEL } from "@/lib/listing/category";
import { LIMITS, proofsFor, staleMentions } from "@/lib/listing/draft";
import { proofById } from "@/lib/listing/proofs";
import { cellZones, fitTemplate, PEOPLE_LABEL, RATIO_LABEL, type Box, type Layout, type Template } from "@/lib/listing/templates";

type Mode = "pick" | "move" | "draw";
const KIND_NAME: Record<string, string> = { title: "大标题", sub: "小字", tag: "标签", card: "格", icon: "图标", person: "人物", garment: "衣服", swatch: "色块", other: "其他" };
const TEXT_KINDS = ["title", "sub", "tag"];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (b: Box): Box => b.map(v => Math.round(v * 10) / 10) as Box;
const area = (b: Box) => b[2] * b[3];
const inside = (b: Box, x: number, y: number) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];

/** The layout's zones of a finished image, with the cards it was made with: only a fallback for an image not recognised yet. */
export function templateOf(layout: Layout, slot: SlotState): { template: Template; ratio: number; kind: "square" | "portrait" | "long" } {
  const kind = slot.slot.split(":")[0] as "square" | "portrait" | "long";
  if (kind === "long" || !slot.task) return { template: layout.long, ratio: 2 / 3, kind: "long" };
  return { template: fitTemplate(layout.templates[slot.task][kind], slot.words?.cells.length ?? 0), ratio: kind === "square" ? 1 : 3 / 4, kind };
}
/** The layout's zones as elements, with the words they were given. */
function estimated(t: Template, w: Words | null): Element[] {
  const cells = cellZones(t);
  return t.zones.map(z => {
    const n = Number(z.id.replace(/\D/g, "")) - 1;
    const text = !w ? "" : z.kind === "title" ? w.title : z.kind === "sub" ? w.sub : z.kind === "tag" ? w.tags[n] ?? "" : cells.includes(z) ? w.cells[cells.indexOf(z)]?.caption ?? "" : "";
    return { id: z.id, kind: z.kind, box: z.box, text, zone: z.id };
  }).filter(e => !TEXT_KINDS.includes(e.kind) || e.text);
}
const nameOf = (e: Element) => e.label ?? `${KIND_NAME[e.kind]}${e.kind === "card" || e.kind === "icon" ? " " + (e.zone ?? e.id).replace(/\D/g, "") : ""}`;

export function CanvasEditor({ detail, slot, layout, unit, exempt, onClose, onDone, onError }: {
  detail: Detail; slot: SlotState; layout: Layout; unit: number; exempt: boolean;
  onClose: () => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void;
}) {
  const { template, ratio, kind } = templateOf(layout, slot);
  const [viewing, setViewing] = useState(slot.image ?? slot.history.at(-1)?.id ?? "");
  const version = slot.history.find(v => v.id === viewing), words: Words | null = version?.words ?? slot.words;
  const found = version?.elements;
  const elements = found ?? estimated(template, words);
  const [mode, setMode] = useState<Mode>("pick");
  const [selected, setSelected] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>(() => Object.fromEntries(elements.map(e => [e.id, e.box])));
  const [moveTo, setMoveTo] = useState<Box | null>(null);
  const [drawn, setDrawn] = useState<Box | null>(null);
  const [form, setForm] = useState<{ point?: string; proof?: string; caption?: string; text?: string; request?: string }>({});
  const [saving, setSaving] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ op: "move" | "resize" | "draw" | "target"; id?: string; x: number; y: number; box: Box; moved: boolean; hits: string[] } | null>(null);
  const busy = slot.status === "queued" || slot.status === "running";
  const category = categoryById(detail.plan?.category ?? "generic");
  const points = (detail.plan?.points ?? []).filter(p => p.on && p.type !== "定位");
  const pointOf = (id?: string | null) => detail.plan?.points.find(p => p.id === id);
  const el = elements.find(e => e.id === selected);
  const cellIndex = el?.zone && /^(card|icon)/.test(el.zone) ? Number(el.zone.replace(/\D/g, "")) - 1 : -1;
  const cell = cellIndex >= 0 ? words?.cells[cellIndex] : undefined;
  const cost = exempt ? "" : ` · ${unit} 积分`;
  const boxOf = (id: string) => boxes[id] ?? elements.find(e => e.id === id)!.box;

  const choose = (id: string | null) => { setSelected(id); setForm({}); setMoveTo(null); };
  const pct = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width * 100, 0, 100), y: clamp((e.clientY - r.top) / r.height * 100, 0, 100) };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const p = pct(e), dx = p.x - d.x, dy = p.y - d.y, [l, t, w, h] = d.box;
      if (Math.abs(dx) + Math.abs(dy) > 0.6) d.moved = true;
      if (!d.moved) return;
      if (d.op === "draw") setDrawn(round([Math.min(d.x, p.x), Math.min(d.y, p.y), Math.abs(dx), Math.abs(dy)]));
      else if (d.op === "resize") setBoxes(b => ({ ...b, [d.id!]: round([l, t, clamp(w + dx, 3, 100 - l), clamp(h + dy, 3, 100 - t)]) }));
      else { const next = round([clamp(l + dx, 0, 100 - w), clamp(t + dy, 0, 100 - h), w, h]); if (d.op === "target") setMoveTo(next); else setBoxes(b => ({ ...b, [d.id!]: next })); }
    };
    const up = () => {
      const d = drag.current; drag.current = null;
      // A click on the selected piece without moving it goes to the one underneath.
      if (d && !d.moved && d.op === "move" && d.hits.length > 1 && d.id) { const k = d.hits.indexOf(d.id); choose(d.hits[(k + 1) % d.hits.length]); }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  });
  /** Press on the image: the selected piece if it is under the pointer (to drag it), else the smallest piece there. */
  const press = (e: React.PointerEvent) => {
    e.preventDefault();
    const p = pct(e);
    if (mode === "draw") { drag.current = { op: "draw", ...p, box: [p.x, p.y, 0, 0], moved: false, hits: [] }; setDrawn(null); return; }
    const hits = elements.filter(x => inside(boxOf(x.id), p.x, p.y)).sort((a, b) => area(boxOf(a.id)) - area(boxOf(b.id))).map(x => x.id);
    if (!hits.length) { choose(null); return; }
    const id = selected && hits.includes(selected) ? selected : hits[0];
    if (id !== selected) choose(id);
    if (mode === "move") { drag.current = { op: "target", id, ...p, box: moveTo ?? boxOf(id), moved: false, hits }; if (!moveTo) setMoveTo(boxOf(id)); }
    else drag.current = { op: "move", id, ...p, box: boxOf(id), moved: id !== selected, hits };
  };
  const grip = (e: React.PointerEvent, id: string) => { e.stopPropagation(); e.preventDefault(); drag.current = { op: "resize", id, ...pct(e), box: boxOf(id), moved: false, hits: [] }; };

  const submit = async (edit: Omit<CanvasEdit, "slot" | "base">, message: string) => {
    setSaving(true);
    try { await post(`projects/${detail.id}/edit`, { slot: slot.slot, base: viewing, ...edit }); choose(null); setDrawn(null); await onDone(message); }
    catch (error) { onError((error as Error).message); } finally { setSaving(false); }
  };
  const choosePoint = (id: string) => { const p = pointOf(id); setForm(f => ({ ...f, point: id, proof: undefined, caption: p?.text ?? f.caption })); };
  const startDraw = (box: Box, request: string) => { setMode("draw"); choose(null); setDrawn(box); setForm({ request }); };

  // What the image still says about a cell's old point after it gets another.
  const oldPoint = pointOf(cell?.point), newPoint = pointOf(form.point ?? cell?.point);
  const stale = words && cell && form.point && form.point !== cell.point && oldPoint ? staleMentions(words, [oldPoint.text, oldPoint.part]) : [];
  const proofs = newPoint ? proofsFor(newPoint, category).filter(p => !p.person || template.people > 0) : [];
  const proofNow = form.proof ?? (form.point && form.point !== cell?.point ? proofs[0]?.id : cell?.proof);
  const isText = !!el && TEXT_KINDS.includes(el.kind) && !!el.zone;
  const maxOf = (k: string) => k === "title" ? LIMITS.title : k === "sub" ? LIMITS.sub : LIMITS.tag;
  const textSubmit = () => el && submit({ mode: "text", zone: el.zone, box: boxOf(el.id), text: (form.text ?? "").trim() }, "开始改字，约 1 分钟");

  const editor = () => {
    if (mode === "draw") return (<>
      <h4>自己框一块</h4>
      <p className="lp-muted">在图上拖出一个框，写清这里要画什么。只重画框里，框外不动。</p>
      <textarea maxLength={200} placeholder="比如：这里换成一只手把手机放进口袋；或者：去掉这块，补成背景" value={form.request ?? ""} onChange={e => setForm({ request: e.target.value })} />
      <button type="button" className="lp-btn primary" disabled={!drawn || drawn[2] < 3 || drawn[3] < 3 || !form.request?.trim() || saving || busy} onClick={() => void submit({ mode: "free", box: drawn!, request: form.request!.trim() }, "开始重画框里的部分，约 1 分钟")}>{drawn && drawn[2] >= 3 ? `重画框里${cost}` : "先在图上拖一个框"}</button>
    </>);
    if (!el) return <p className="lp-muted">点上面列表里的一项，或者直接点图。框叠在一起时，再点一下会轮到下面那层。</p>;
    const head = <h4>{nameOf(el)}{el.text ? <small> · {el.text}</small> : null}</h4>;
    if (mode === "move") return (<>
      {head}<p className="lp-muted">在图上把它拖到新位置（绿色框）。原来的地方补上背景，新位置重新画这一块。</p>
      <button type="button" className="lp-btn primary" disabled={!moveTo || !el.zone || saving || busy} onClick={() => void submit({ mode: "move", zone: el.zone, box: boxOf(el.id), to: moveTo! }, "开始按新位置重排，约 1 分钟")}>{moveTo ? `按新位置重排${cost}` : "先拖到新位置"}</button>
    </>);
    if (isText) return (<>
      {head}
      <label className="lp-field"><span>改成</span><input maxLength={maxOf(el.kind)} value={form.text ?? el.text ?? ""} onChange={e => setForm({ text: e.target.value })} /></label>
      <p className="lp-muted">位置、字体、颜色照原来的，只换字。删空就是去掉这句。也可以直接在图上那个框下面改。</p>
      <button type="button" className="lp-btn primary" disabled={saving || busy || form.text === undefined || form.text === el.text} onClick={() => void textSubmit()}>只改这句字{cost}</button>
    </>);
    if (cellIndex >= 0) return (<>
      {head}
      <label className="lp-field"><span>讲什么</span><select value={form.point ?? cell?.point ?? ""} onChange={e => choosePoint(e.target.value)}>
        {!cell?.point && <option value="">（这格原来没放卖点）</option>}{points.map(p => <option key={p.id} value={p.id}>{p.text}</option>)}</select></label>
      {newPoint && <label className="lp-field"><span>怎么画</span><select value={proofNow ?? ""} onChange={e => setForm(f => ({ ...f, proof: e.target.value }))}>{proofs.map(p => <option key={p.id} value={p.id}>{p.kind} · {p.name}</option>)}</select></label>}
      {proofNow && <p className="lp-muted lp-recipe">{proofById(proofNow)?.recipe.replace("{part}", newPoint?.part || newPoint?.text || "")}</p>}
      <label className="lp-field"><span>格下的字</span><input maxLength={LIMITS.cell} value={form.caption ?? el.text ?? ""} onChange={e => setForm(f => ({ ...f, caption: e.target.value }))} /></label>
      {stale.length > 0 && <div className="lp-say y">换掉以后，这张图上{stale.join("、")}还在说「{oldPoint?.part || oldPoint?.text}」。重画完点那句字改一下，或者先改字再换格。</div>}
      <button type="button" className="lp-btn primary" disabled={saving || busy || (!form.point && !form.proof && form.caption === undefined)} onClick={() => void submit({ mode: "cell", zone: el.zone, box: boxOf(el.id), point: form.point ?? cell?.point ?? undefined, proof: proofNow, caption: form.caption?.trim() || undefined }, "开始重画这一格，约 1 分钟")}>只重画这一格{cost}</button>
    </>);
    if (!el.zone) return (<>
      {head}
      <p className="lp-muted">这一块不在方案里，是模型自己加的。</p>
      <div className="lp-chips"><button type="button" className="lp-btn" disabled={saving || busy} onClick={() => void submit({ mode: "free", box: boxOf(el.id), request: "去掉这一块，补成和周围一致的背景" }, "开始去掉这一块，约 1 分钟")}>去掉这块{cost}</button>
        <button type="button" className="lp-btn" onClick={() => startDraw(boxOf(el.id), "")}>改成别的…</button></div>
    </>);
    if (el.kind === "person") return (<>
      {head}
      <p className="lp-muted">{PEOPLE_LABEL(template)}，是模特定妆照里的人。</p>
      <div className="lp-chips"><button type="button" className="lp-btn" onClick={() => startDraw(boxOf(el.id), "人物换个动作：")}>换个动作或表情…</button><button type="button" className="lp-btn" onClick={() => { setMode("move"); setMoveTo(null); }}>挪位置…</button></div>
    </>);
    return (<>{head}<p className="lp-muted">{el.kind === "swatch" ? "色块按方案里的颜色画，颜色在定方案里改。" : "想换摆法，用「自己框一块」写要求。"}</p></>);
  };

  const inlineAt = el && isText && mode === "pick" ? boxOf(el.id) : null;
  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-canvas-box" role="dialog" aria-modal="true" aria-label="画板">
        <div className="lp-box-head"><div><h3>画板 · {RATIO_LABEL[kind]}{slot.task ? ` · ${TASK_LABEL[slot.task]}` : ""}</h3>
          <p className="lp-sub">{kind === "square" ? "只重画选中的那一块，其余一个像素都不变。改动会写进方案，之后出竖版时跟着改。" : "改的是这一张竖图，不会改方图。"}</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <div className="lp-canvas">
            <div>
              <div className="lp-modes">{([["pick", "选中修改"], ["move", "挪位置"], ["draw", "自己框一块"]] as const).map(([m, label]) => (
                <button type="button" key={m} className={mode === m ? "on" : ""} onClick={() => { setMode(m); setMoveTo(null); setDrawn(null); if (m === "draw") choose(null); }}>{label}</button>))}</div>
              <div ref={stage} className={"lp-stage " + mode} style={{ aspectRatio: String(ratio), ["--r" as string]: ratio }} onPointerDown={press}>
                {viewing && <img src={assetUrl(viewing)} alt="" draggable={false} />}
                {elements.map(x => {
                  const [l, t, w, h] = boxOf(x.id), on = selected === x.id;
                  return (
                    <div key={x.id} className={"zone " + x.kind + (on ? " on" : "") + (x.zone ? "" : " extra")} style={{ left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }}>
                      {/* Words would be hidden under their own label: it sits just outside the box instead. */}
                      <span className={"lbl" + (TEXT_KINDS.includes(x.kind) ? (t >= 3 ? " above" : " below") : "")}>{nameOf(x)}{x.text && x.kind !== "person" && !TEXT_KINDS.includes(x.kind) ? ` · ${x.text}` : ""}</span>
                      {on && mode === "pick" && <span className="grip" onPointerDown={e => grip(e, x.id)} />}
                    </div>);
                })}
                {moveTo && <div className="zone target" style={{ left: `${moveTo[0]}%`, top: `${moveTo[1]}%`, width: `${moveTo[2]}%`, height: `${moveTo[3]}%` }}><span className="lbl">新位置</span></div>}
                {drawn && <div className="zone drawn" style={{ left: `${drawn[0]}%`, top: `${drawn[1]}%`, width: `${drawn[2]}%`, height: `${drawn[3]}%` }} />}
                {inlineAt && el && (
                  <div className={"lp-inline" + (inlineAt[1] + inlineAt[3] > 80 ? " up" : "")} style={{ left: `${clamp(inlineAt[0], 0, 60)}%`, ...(inlineAt[1] + inlineAt[3] > 80 ? { bottom: `${100 - inlineAt[1]}%` } : { top: `${inlineAt[1] + inlineAt[3]}%` }) }} onPointerDown={e => e.stopPropagation()}>
                    <input autoFocus maxLength={maxOf(el.kind)} value={form.text ?? el.text ?? ""} onChange={e => setForm({ text: e.target.value })} onKeyDown={e => { if (e.key === "Enter" && form.text !== undefined && form.text !== el.text) void textSubmit(); }} />
                    <button type="button" className="lp-btn sm primary" disabled={saving || busy || form.text === undefined || form.text === el.text} onClick={() => void textSubmit()}>改字{cost}</button>
                  </div>)}
                {busy && <div className="lp-stage-busy">{slot.status === "running" ? "正在重画…" : "排队中…"}</div>}
              </div>
              {slot.history.length > 1 && (
                <div className="lp-vers">版本：{slot.history.map((v, i) => (
                  <button type="button" key={v.id} className={v.id === viewing ? "sel" : ""} title={`第 ${i + 1} 版${v.change ? "：" + v.change : ""}`} onClick={() => { setViewing(v.id); choose(null); setBoxes(Object.fromEntries((v.elements ?? estimated(template, v.words)).map(e => [e.id, e.box]))); }}>
                    <img src={assetUrl(v.id)} alt="" style={{ aspectRatio: String(ratio) }} /></button>))}
                  {viewing === slot.image ? <span>正在用第 {slot.history.findIndex(v => v.id === slot.image) + 1} 版</span>
                    : <button type="button" className="lp-btn sm" onClick={async () => { try { await post(`projects/${detail.id}/current`, { slot: slot.slot, asset: viewing }); await onDone("已改用这一版，下载也用这一版"); } catch (error) { onError((error as Error).message); } }}>改用这一版</button>}
                </div>)}
              {version?.change && <p className="lp-muted lp-small">这一版：{version.change}</p>}
            </div>
            <div className="lp-canvas-panel">
              <h4>图上有这些 <small>{found ? "出图后自动认出来的" : "这张还没认位置，框按版式估的，可能不准：拖一下对齐"}</small></h4>
              <div className="lp-layers">{elements.map(x => (
                <button type="button" key={x.id} className={"lp-layer" + (selected === x.id ? " on" : "") + (x.zone ? "" : " extra")} onClick={() => { if (mode === "draw") setMode("pick"); choose(x.id); }}>
                  <b>{nameOf(x)}</b><span>{x.kind === "person" ? PEOPLE_LABEL(template) : x.text || "—"}</span></button>))}</div>
              <div className="lp-editor">{editor()}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
