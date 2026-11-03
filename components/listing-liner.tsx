"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图: a liner image the material lacks, made on the plan before anything is drawn (10-22). A
 * liner colour the shop sells but never photographed: the user uploads a photo of it, or has AI draw
 * it from the material's other liners (ticked as references) and their own words, trying until one
 * looks right. The one they take joins the material as that liner worn alone, so the SKU images are
 * drawn over it and show it on their cards. The same panel tidies a liner the material has onto white.
 */
import { useState } from "react";
import { adoptDrawn, api, drawMaterial, type LinerTag } from "@/lib/listing/client-api";
import { linerWhitePrompt } from "@/lib/listing/wear";

export type LinerPick = { label: string; url: string; caption: string };

const promptOf = (inner: string, color: string, tidy: boolean) => tidy
  ? linerWhitePrompt(inner, color)
  : `照参考图这件${inner}内胆，款式、领子、拉链、口袋和面料质感都不变，颜色换成${color || "（写上颜色）"}；做成电商白底图：纯白背景，隐形模特效果，正面朝前，拉链拉上，画面里只有这件内胆，不要人、不要文字和水印。`;

export function LinerDialog({ projectId, inner, name, color: preset, candidates, price, onUpload, onDone, onClose }: {
  /** `inner` tags what is added to the material; `name` (10-28) is what the plan calls the liner, when renamed. */
  projectId: string; inner: string; name?: string;
  /** A colour the material has (tidying its image onto white); none: a new colour. */
  color?: string;
  /** The material's images of this liner, any colour: references to tick. */
  candidates: LinerPick[];
  price: string;
  onUpload: (file: File, liner?: LinerTag) => Promise<{ label: string }>;
  /** The image taken into the material, and the colour it is. */
  onDone: (label: string, color: string) => void | Promise<void>; onClose: () => void;
}) {
  const tidy = !!preset;
  const [color, setColor] = useState(preset ?? "");
  const [mode, setMode] = useState<"ai" | "upload">(tidy ? "ai" : "ai");
  const [picked, setPicked] = useState<string[]>(candidates.slice(0, 1).map(c => c.label));
  const [extra, setExtra] = useState<{ asset: string; url: string }[]>([]);
  const [own, setOwn] = useState<string | null>(null);
  const [made, setMade] = useState<{ asset: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const called = name || inner, prompt = own ?? promptOf(called, color, tidy);
  const ready = !!color.trim();

  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (e) { setError((e as Error).message || "没成功，可以再试一次"); } finally { setBusy(false); } };
  const generate = () => run(async () => {
    if (!picked.length && !extra.length) throw new Error("至少点选一张参考图");
    const image = await drawMaterial(projectId, prompt, picked, extra.map(x => x.asset));
    setMade(m => [image, ...m]);
  });
  const adopt = (asset: string) => run(async () => { const { label } = await adoptDrawn(projectId, asset, { inner, color: color.trim() }); await onDone(label, color.trim()); });
  const upload = (file: File) => run(async () => { const { label } = await onUpload(file, { inner, color: color.trim() }); await onDone(label, color.trim()); });
  const addReference = (file: File) => run(async () => {
    const { asset } = await api<{ asset: string }>(`projects/${projectId}/refs`, { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
    setExtra(x => [...x, { asset, url: URL.createObjectURL(file) }]);
  });

  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="lp-box lp-liner" role="dialog" aria-modal="true" aria-label="内胆图">
        <div className="lp-box-head"><div><h3>{tidy ? `把「${preset}${called}内胆」整理成白底图` : `新增一个${called}内胆的颜色`}</h3>
          <p className="lp-sub">{tidy ? "照素材里这件内胆，出一张干净的白底图，SKU 卡上的内胆小图用它。" : "素材里没有这个颜色的内胆：上传一张照片，或者让 AI 照别的颜色画一张。用了以后，SKU 图照它画内胆、卡片上放它。"}</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" disabled={busy} onClick={onClose}>关闭</button></div>
        <div className="lp-liner-body">
          <div className="row"><label>内胆</label><b>{called}内胆</b>
            <label>颜色</label>{tidy ? <b>{preset}</b> : <input className="lp-in" value={color} placeholder="比如：黑色" maxLength={12} onChange={e => setColor(e.target.value)} />}</div>
          {!tidy && <div className="lp-chips modes">{([["ai", "AI 生成"], ["upload", "上传照片"]] as const).map(([m, name]) => (
            <label key={m} className={"lp-chip" + (mode === m ? " on" : "")}><input type="radio" hidden checked={mode === m} onChange={() => setMode(m)} />{name}</label>))}</div>}
          {mode === "upload" ? <div className="upload">
            <label className={"lp-btn" + (ready ? " primary" : "")} aria-disabled={!ready}>选一张这个颜色的内胆照片
              <input type="file" accept="image/*" hidden disabled={!ready || busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} /></label>
            <p className="lp-muted lp-small">{ready ? "传上来就算素材里的一张，不收费。单独拍的内胆最好，套在外套里的也行。" : "先写上颜色"}</p>
          </div> : <>
            <div className="refs"><label>参考图 <small>点选，可多选；默认选了素材里同一件内胆</small></label>
              <div className="pics">{candidates.map(c => (
                <button type="button" key={c.label} className={"pic" + (picked.includes(c.label) ? " on" : "")} title={c.caption}
                  onClick={() => setPicked(p => p.includes(c.label) ? p.filter(x => x !== c.label) : [...p, c.label])}><img src={c.url} alt="" /><small>{c.caption}</small></button>))}
                {extra.map(x => <span key={x.asset} className="pic on"><img src={x.url} alt="" /><small>上传的</small></span>)}
                <label className="pic add">＋ 上传参考图<input type="file" accept="image/*" hidden disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addReference(f); }} /></label></div></div>
            <div className="ask"><label htmlFor="lp-liner-ask">提示词 <small>可以改；改完再生成看看</small></label>
              <textarea id="lp-liner-ask" rows={4} value={prompt} onChange={e => setOwn(e.target.value)} />
              <div className="go"><button type="button" className="lp-btn primary" disabled={busy || !ready} onClick={() => void generate()}>{busy ? "生成中…约 40 秒" : `生成${price ? ` · ${price}` : ""}`}</button>
                {own !== null && <button type="button" className="lp-btn link" onClick={() => setOwn(null)}>恢复默认提示词</button>}
                {!ready && <span className="lp-warn">先写上颜色</span>}</div></div>
            {made.length > 0 && <div className="made"><label>生成的 <small>每次的都留着，挑满意的点「用这张」</small></label>
              <div className="pics">{made.map((m, k) => (
                <figure key={m.asset}><a href={m.url} target="_blank" rel="noreferrer"><img src={m.url} alt="" /></a>
                  <figcaption>第 {made.length - k} 次 <button type="button" className="lp-btn sm primary" disabled={busy} onClick={() => void adopt(m.asset)}>用这张</button></figcaption></figure>))}</div></div>}
          </>}
          {error && <p className="lp-warn">{error}</p>}
        </div>
      </div>
    </div>
  );
}
