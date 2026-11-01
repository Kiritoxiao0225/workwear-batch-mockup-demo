"use client";
/* eslint-disable @next/next/no-img-element -- images come from the listing API */
/**
 * 电商主图: change one image. The current image is sent to the model as the base, the user writes
 * what to change (and may add up to REFS_MAX reference images, each framed to the part that matters,
 * 11-01), and each result can be adopted: it replaces the
 * image in place and the old one goes into the history, from which it can be brought back.
 * With `background` (the product's images, 10-25) the redraw is only asked for here and made in the
 * background: the dialog can be closed at once, and shows the image's redraw while it is open.
 */
import { useState } from "react";
import type { Redraw } from "@/lib/listing/api-types";
import { CropView, cropFile, type Box } from "./listing-crop";
import { editActive, editTag, editText, useNow } from "./listing-edits";

const REFS_MAX = 4;
/** One reference: the user's picture, the box drawn on it and the part cut out (sent instead of the whole). */
type Ref = { key: number; file: File; url: string; box?: Box; cut?: File; cutUrl?: string };

const EXAMPLES = ["大字改成", "背景换成", "换个姿势", "不改内容，重新画一张"];

export function EditDialog({ title, note, current, history, price, background = false, job, made: ready = [], initialAsk = "", onGenerate, onAdopt, onKeep, onClose }: {
  title: string; note?: string; current: string; history: { image: string; label: string }[]; price: string;
  /** background: the redraw is made in the background; `job` is then the image's latest one, `made` its new image waiting to be adopted. */
  background?: boolean; job?: Redraw; made?: string[]; initialAsk?: string;
  /** Makes one new image from the current one, with the references in order; resolves to its address, or to null when it is made in the background. */
  onGenerate: (ask: string, references: File[]) => Promise<string | null>;
  /** Puts an image (new or from the history) in place of the current one. */
  onAdopt: (image: string) => void;
  /** Keeps the current image: the new one (or the failure) is put away. */
  onKeep?: () => void; onClose: () => void;
}) {
  const [ask, setAsk] = useState(initialAsk);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [framing, setFraming] = useState<number | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const active = editActive(job), open = job?.open ? job : undefined;
  const now = useNow(active);

  const generate = async () => {
    if (!ask.trim()) { setError("先写一句想怎么改"); return; }
    setBusy(true); setError(""); setSent(false);
    try { const image = await onGenerate(ask.trim(), refs.map(r => r.cut ?? r.file)); if (image) setMade(m => [image, ...m]); else { setSent(true); setRefs([]); } }
    catch (e) { setError((e as Error).message || "没生成出来，没扣积分，可以再试一次"); }
    finally { setBusy(false); }
  };
  const cands = [...made, ...ready.filter(x => !made.includes(x))];
  const add = (files: FileList | null) => {
    const room = REFS_MAX - refs.length, list = [...(files ?? [])].filter(f => f.type.startsWith("image/"));
    if (list.length > room) setError(`参考图最多 ${REFS_MAX} 张，多的没加`);
    setRefs(r => [...r, ...list.slice(0, room).map((file, i) => ({ key: Date.now() + i, file, url: URL.createObjectURL(file) }))]);
  };
  const frame = framing === null ? undefined : refs.find(r => r.key === framing);
  const setBox = async (key: number, box: Box | undefined) => {
    const r = refs.find(x => x.key === key); if (!r) return;
    setFraming(null);
    try {
      const cut = box ? await cropFile(r.file, box) : undefined;
      setRefs(list => list.map(x => x.key === key ? { ...x, box, cut, cutUrl: cut ? URL.createObjectURL(cut) : undefined } : x));
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box lp-redo" role="dialog" aria-modal="true" aria-label={title}>
        <div className="lp-box-head"><h3>{title}</h3><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-edit-body">
          <figure className="cur"><img src={current} alt="现在这张" /><figcaption>现在这张，会当底图发给模型，排版和衣服都保留{note && <><br /><b>{note}</b></>}</figcaption></figure>
          <div className="form">
            <label htmlFor="lp-edit-ask">想怎么改</label>
            <textarea id="lp-edit-ask" rows={3} value={ask} placeholder="比如：大字改成「三级防水」；或者：背景换成工地，下雨天" onChange={e => setAsk(e.target.value)} />
            <div className="eg"><span className="lp-muted lp-small">常用：</span>{EXAMPLES.map(x => <button type="button" key={x} onClick={() => setAsk(x === EXAMPLES[3] ? x : x + "")}>{x}{x === EXAMPLES[3] ? "" : "……"}</button>)}</div>
            <label>参考图 <span className="lp-muted lp-small">可选，最多 {REFS_MAX} 张，比如想要的背景、姿势、衣服里面；要求里可以写「照参考图2的内胆」</span></label>
            {frame ? <CropView src={frame.url} initial={frame.box} onDone={box => void setBox(frame.key, box)} onWhole={() => void setBox(frame.key, undefined)} onCancel={() => setFraming(null)} />
              : <div className="refs">{refs.map((r, i) => (
                <figure key={r.key}><img src={r.cutUrl ?? r.url} alt={`参考图${i + 1}`} /><figcaption>参考图{i + 1}{r.cut ? " · 框选" : ""}</figcaption>
                  <span><button type="button" className="lp-btn link" onClick={() => setFraming(r.key)}>{r.cut ? "重新框" : "框选"}</button>
                    <button type="button" className="lp-btn link" onClick={() => setRefs(list => list.filter(x => x.key !== r.key))}>移除</button></span></figure>))}
                {refs.length < REFS_MAX && <label className="ref"><span>＋ 上传参考图</span>
                  <input type="file" accept="image/*" multiple hidden onChange={e => { add(e.target.files); e.target.value = ""; }} /></label>}</div>}
            {refs.length > 0 && !frame && <p className="lp-muted lp-small">只想让它学图里的一块（比如内胆），点「框选」框出来，比整张传更准。</p>}
            <div className="go"><button type="button" className="lp-btn primary" disabled={busy || active || !!frame} onClick={() => void generate()}>{busy ? (!background ? "生成中，约 40 秒…" : refs.length ? "上传参考图…" : "提交中…") : active ? "这张正在改…" : `生成${price ? ` · ${price}` : ""}`}</button>{error && <span className="lp-warn">{error}</span>}</div>
            {open && <div className={"lp-edit-job " + editTag(open).tone}><b>{editTag(open).tag}</b>{open.ask && <span>「{open.ask}」</span>}<span>{editText(open, now)}</span>
              {active && <small>可以关掉这个窗口去改别的图，进度在「改图进度」里看，改好了图上会标「新图待采用」</small>}
              {open.status === "failed" && onKeep && <button type="button" className="lp-btn link" onClick={onKeep}>知道了</button>}</div>}
            {sent && !open && <div className="lp-edit-job b"><b>已提交</b><span>在后台改，可以关掉这个窗口去改别的图</span></div>}
            {cands.length > 0 && <><label>新生成的 <span className="lp-muted lp-small">满意就点采用；不满意改一下描述再生成</span></label>
              <div className="cands">{cands.map((src, i) => <figure key={src + i}><img src={src} alt="" /><button type="button" className="lp-btn sm primary" onClick={() => onAdopt(src)}>采用</button>
                {onKeep && ready.includes(src) && <button type="button" className="lp-btn sm ghost" title="新图留在历史里，还能换回" onClick={onKeep}>不用，留现在这张</button>}</figure>)}</div></>}
            {history.length > 0 && <details className="hist"><summary>历史（{history.length}）</summary>
              <div className="cands">{history.map((h, i) => <figure key={h.image + i}><img src={h.image} alt="" /><figcaption>{h.label}</figcaption><button type="button" className="lp-btn sm" onClick={() => onAdopt(h.image)}>换回这张</button></figure>)}</div></details>}
          </div>
        </div>
      </div>
    </div>
  );
}
