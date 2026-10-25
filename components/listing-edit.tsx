"use client";
/* eslint-disable @next/next/no-img-element -- images come from the listing API */
/**
 * 电商主图: change one image. The current image is sent to the model as the base, the user writes
 * what to change (and may add a reference image), and each result can be adopted: it replaces the
 * image in place and the old one goes into the history, from which it can be brought back.
 * With `background` (the product's images, 10-25) the redraw is only asked for here and made in the
 * background: the dialog can be closed at once, and shows the image's redraw while it is open.
 */
import { useState } from "react";
import type { Redraw } from "@/lib/listing/api-types";
import { editActive, editTag, editText, useNow } from "./listing-edits";

const EXAMPLES = ["大字改成", "背景换成", "换个姿势", "不改内容，重新画一张"];

export function EditDialog({ title, note, current, history, price, background = false, job, made: ready = [], initialAsk = "", onGenerate, onAdopt, onKeep, onClose }: {
  title: string; note?: string; current: string; history: { image: string; label: string }[]; price: string;
  /** background: the redraw is made in the background; `job` is then the image's latest one, `made` its new image waiting to be adopted. */
  background?: boolean; job?: Redraw; made?: string[]; initialAsk?: string;
  /** Makes one new image from the current one; resolves to its address, or to null when it is made in the background. */
  onGenerate: (ask: string, reference: File | null) => Promise<string | null>;
  /** Puts an image (new or from the history) in place of the current one. */
  onAdopt: (image: string) => void;
  /** Keeps the current image: the new one (or the failure) is put away. */
  onKeep?: () => void; onClose: () => void;
}) {
  const [ask, setAsk] = useState(initialAsk);
  const [reference, setReference] = useState<{ file: File; url: string } | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const active = editActive(job), open = job?.open ? job : undefined;
  const now = useNow(active);

  const generate = async () => {
    if (!ask.trim()) { setError("先写一句想怎么改"); return; }
    setBusy(true); setError(""); setSent(false);
    try { const image = await onGenerate(ask.trim(), reference?.file ?? null); if (image) setMade(m => [image, ...m]); else { setSent(true); setReference(null); } }
    catch (e) { setError((e as Error).message || "没生成出来，没扣积分，可以再试一次"); }
    finally { setBusy(false); }
  };
  const cands = [...made, ...ready.filter(x => !made.includes(x))];

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
            <label>参考图 <span className="lp-muted lp-small">可选，比如想要的背景或姿势</span></label>
            <label className="ref">{reference ? <img src={reference.url} alt="参考图" /> : <span>＋ 上传参考图</span>}
              <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) setReference({ file: f, url: URL.createObjectURL(f) }); }} /></label>
            {reference && <button type="button" className="lp-btn link" onClick={() => setReference(null)}>移除参考图</button>}
            <div className="go"><button type="button" className="lp-btn primary" disabled={busy || active} onClick={() => void generate()}>{busy ? (!background ? "生成中，约 40 秒…" : reference ? "上传参考图…" : "提交中…") : active ? "这张正在改…" : `生成${price ? ` · ${price}` : ""}`}</button>{error && <span className="lp-warn">{error}</span>}</div>
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
