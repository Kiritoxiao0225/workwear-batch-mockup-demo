"use client";
/* eslint-disable @next/next/no-img-element -- images come from the listing API */
/**
 * 电商主图: change one image. The current image is sent to the model as the base, the user writes
 * what to change (and may add a reference image), and each result can be adopted: it replaces the
 * image in place and the old one goes into the history, from which it can be brought back.
 */
import { useState } from "react";

const EXAMPLES = ["大字改成", "背景换成", "换个姿势", "不改内容，重新画一张"];

export function EditDialog({ title, note, current, history, price, onGenerate, onAdopt, onClose }: {
  title: string; note?: string; current: string; history: { image: string; label: string }[]; price: string;
  /** Makes one new image from the current one; resolves to its address. */
  onGenerate: (ask: string, reference: File | null) => Promise<string>;
  /** Puts an image (new or from the history) in place of the current one. */
  onAdopt: (image: string) => void; onClose: () => void;
}) {
  const [ask, setAsk] = useState("");
  const [reference, setReference] = useState<{ file: File; url: string } | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    if (!ask.trim()) { setError("先写一句想怎么改"); return; }
    setBusy(true); setError("");
    try { const image = await onGenerate(ask.trim(), reference?.file ?? null); setMade(m => [image, ...m]); }
    catch (e) { setError((e as Error).message || "没生成出来，没扣积分，可以再试一次"); }
    finally { setBusy(false); }
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
            <label>参考图 <span className="lp-muted lp-small">可选，比如想要的背景或姿势</span></label>
            <label className="ref">{reference ? <img src={reference.url} alt="参考图" /> : <span>＋ 上传参考图</span>}
              <input type="file" accept="image/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) setReference({ file: f, url: URL.createObjectURL(f) }); }} /></label>
            {reference && <button type="button" className="lp-btn link" onClick={() => setReference(null)}>移除参考图</button>}
            <div className="go"><button type="button" className="lp-btn primary" disabled={busy} onClick={() => void generate()}>{busy ? "生成中，约 40 秒…" : `生成${price ? ` · ${price}` : ""}`}</button>{error && <span className="lp-warn">{error}</span>}</div>
            {made.length > 0 && <><label>新生成的 <span className="lp-muted lp-small">满意就点采用；不满意改一下描述再生成</span></label>
              <div className="cands">{made.map((src, i) => <figure key={src + i}><img src={src} alt="" /><button type="button" className="lp-btn sm primary" onClick={() => onAdopt(src)}>采用</button></figure>)}</div></>}
            {history.length > 0 && <details className="hist"><summary>历史（{history.length}）</summary>
              <div className="cands">{history.map((h, i) => <figure key={h.image + i}><img src={h.image} alt="" /><figcaption>{h.label}</figcaption><button type="button" className="lp-btn sm" onClick={() => onAdopt(h.image)}>换回这张</button></figure>)}</div></details>}
          </div>
        </div>
      </div>
    </div>
  );
}
