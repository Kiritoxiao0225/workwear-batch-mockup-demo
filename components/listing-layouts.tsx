"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图 layouts: the built-in ones and those the team learned. Learning takes 3–10 reference
 * images; the result lists, for each kind of image, where things go and whether it has people (and
 * how the garment is shown when it has none), and the user can correct that before saving.
 */
import { useEffect, useRef, useState } from "react";
import type { Config, LayoutCard, LearnState } from "@/lib/listing/api-types";
import { api, assetUrl, post } from "@/lib/listing/client-api";
import { TASK_LABEL, type Task } from "@/lib/listing/category";
import { PEOPLE_LABEL, withPeople, type Display, type People } from "@/lib/listing/templates";
import { Wire } from "./listing-wire";

const IMAGE = /\.(jpe?g|png|webp)$/i;
const TASKS: Task[] = ["首图", "服务", "功能", "细节", "实用", "收口"];
const CHOICES: { label: string; people: People; display?: Display }[] = [
  { label: "无人·平铺", people: 0, display: "平铺" }, { label: "无人·挂拍", people: 0, display: "挂拍" }, { label: "无人·隐形人台", people: 0, display: "隐形人台" },
  { label: "单人", people: 1 }, { label: "双人", people: 2 }, { label: "多人", people: 3 },
];
const STATUS_TEXT: Record<string, string> = { uploading: "还没开始学", queued: "排队中", learning: "正在学，约 2 分钟", draft: "学好了，等你看样图", failed: "没学成" };
const dayOf = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };

/** Built-in layouts and the ones the team learned; learned ones can be deleted, unfinished ones reopened. */
export function MyLayouts({ layouts, learning, onClose, onLearn, onDeleted, onError }: { layouts: LayoutCard[]; learning: Config["learning"]; onClose: () => void; onLearn: (resume?: string) => void; onDeleted: (name: string) => Promise<void>; onError: (message: string) => void }) {
  const remove = async (l: LayoutCard) => {
    if (!window.confirm(`删除「${l.name}」？团队里的人就选不到它了；已经用它出过的图不受影响。`)) return;
    try { await api("layouts/" + l.id, { method: "DELETE" }); await onDeleted(l.name); } catch (error) { onError((error as Error).message); }
  };
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="我的版式">
        <div className="lp-box-head"><div><h3>我的版式</h3><p className="lp-sub">系统自带的，加上你们团队学的；团队里的人都能用。</p></div><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          {learning.length > 0 && <div className="lp-learning">{learning.map(l => (
            <button type="button" key={l.id} className="lp-btn sm" onClick={() => onLearn(l.id)}>「{l.name}」{STATUS_TEXT[l.status] ?? l.status}</button>))}</div>}
          <div className="lp-layouts">{layouts.map(l => (
            <div key={l.id} className="lp-layout">
              <span className={"lp-tag" + (l.own ? " team" : "")}>{l.own ? "团队学的" : "自带"}</span>
              <div className="pics">{l.samples.map(src => <img key={src} src={src} alt="" />)}</div>
              <b>{l.name}</b><p>{l.description}</p>
              <p className="ppl">{TASKS.map(t => `${TASK_LABEL[t]}${PEOPLE_LABEL(l.templates[t].square)}`).join(" · ")}</p>
              {l.own && <p className="by">{l.by}{l.createdAt ? ` · ${dayOf(l.createdAt)}` : ""} · <button type="button" className="lp-btn link" onClick={() => void remove(l)}>删除</button></p>}
            </div>))}
            <button type="button" className="lp-layout add" onClick={() => onLearn()}><b>＋ 学一个新版式</b><p>上传 3–10 张喜欢的主图，AI 学它的风格、排法和哪张有人</p></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Learn a layout: upload 3–10 reference images and a name, the workers learn it (about two
 * minutes, the dialog may be closed), then check each kind of image — where things go, people or
 * not — and three samples, correct the people if needed, and save, relearn or drop it.
 */
export function LearnDialog({ resume, price, shrink, onClose, onSaved, onError }: { resume?: string; price: number; shrink: (f: File) => Promise<Blob>; onClose: () => void; onSaved: (id: string, name: string) => Promise<void>; onError: (message: string) => void }) {
  const [id, setId] = useState(resume ?? "");
  const [step, setStep] = useState<"upload" | "wait" | "view">(resume ? "wait" : "upload");
  const [state, setState] = useState<LearnState | null>(null);
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [people, setPeople] = useState<Partial<Record<Task, { people: People; display?: Display }>>>({});
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step !== "wait" || !id) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<LearnState>("layouts/" + id);
        if (stop) return;
        setState(s);
        if (!["queued", "learning", "uploading"].includes(s.status)) setStep("view");
      } catch (error) { if (!stop) onError((error as Error).message); }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => { stop = true; clearInterval(timer); };
  }, [step, id, onError]);
  const add = (list: FileList | File[]) => {
    const images = [...list].filter(f => IMAGE.test(f.name)).slice(0, 10 - files.length);
    setFiles(f => [...f, ...images.map(file => ({ file, url: URL.createObjectURL(file) }))]);
  };
  const start = async () => {
    const layoutId = crypto.randomUUID();
    try {
      setBusy("正在上传参考图…");
      await post("layouts", { id: layoutId, name: name.trim() });
      for (const [i, f] of files.entries()) {
        setBusy(`正在上传参考图 ${i + 1}/${files.length}…`);
        await api(`layouts/${layoutId}/refs`, { method: "POST", body: await shrink(f.file), headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(f.file.name) } });
      }
      await post(`layouts/${layoutId}/learn`);
      setId(layoutId); setStep("wait");
    } catch (error) {
      onError((error as Error).message);
      await api("layouts/" + layoutId, { method: "DELETE" }).catch(() => {});
    } finally { setBusy(""); }
  };
  const drop = async () => { try { await api("layouts/" + id, { method: "DELETE" }); } catch { /* already gone */ } };
  const relearn = async () => { await drop(); setName(state?.name ?? name); setId(""); setState(null); setPeople({}); setStep("upload"); };
  const save = async () => { try { setBusy("正在保存…"); await post(`layouts/${id}/save`, { people }); await onSaved(id, state!.name); } catch (error) { onError((error as Error).message); } finally { setBusy(""); } };
  const learned = state?.status === "draft" ? state.layout : null;
  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="lp-box lp-plan" role="dialog" aria-modal="true" aria-label="学一个新版式">
        <div className="lp-box-head"><div><h3>学一个新版式{state?.name ? ` · ${state.name}` : ""}</h3>
          <p className="lp-sub">{step === "upload" ? "上传 3–10 张你喜欢的主图，AI 学它们的风格、排法，以及每类图有没有人。" : step === "wait" ? "大约 2 分钟，可以先关掉，学好了在「我的版式」里能看到。" : learned ? "学好了：看看每类图的排法和有没有人，不对的改一下，再看样图。" : "这次没学成。"}</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" disabled={!!busy} onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          {step === "upload" && (<>
            <div className="lp-refs">
              {files.map((f, i) => <div key={f.url} className="ref"><img src={f.url} alt="" /><button type="button" aria-label="去掉" onClick={() => setFiles(list => list.filter((_, k) => k !== i))}>✕</button></div>)}
              {files.length < 10 && <button type="button" className="refadd" onClick={() => input.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); add(e.dataTransfer.files); }}>＋ 选图片<br />或拖进来<br /><small>{files.length}/10</small></button>}
            </div>
            <input ref={input} type="file" accept="image/*" multiple hidden onChange={e => { add(e.target.files!); e.target.value = ""; }} />
            <label className="lp-field"><span>版式名字</span><input maxLength={12} placeholder="比如：细节特写格" value={name} onChange={e => setName(e.target.value)} /></label>
            <div className="lp-say">只学风格和排法：标题放哪、字体感觉、光线色调、卖点标签的样子、怎么分格、哪类图有人。不会照搬对方的文字、logo、人物和衣服。最好是同一种风格的几张图；参考图里没有的那类图，AI 按同一风格补。</div>
          </>)}
          {step === "wait" && <div className="lp-say">{state?.status === "learning" ? "正在学：先看参考图总结风格和排法，再用示例衣服出 3 张样图……" : "排队中，马上开始……"}</div>}
          {step === "view" && learned && (<>
            <div className="lp-learned">
              <div><b>AI 总结的风格</b><p>{learned.description}</p>
                <ul><li>标题：{learned.style.title}</li><li>标签：{learned.style.tag}</li><li>格子：{learned.style.card}</li><li>光线：{learned.style.light}</li><li>背景：{learned.style.background}</li></ul></div>
              <div><b>样图（用示例衣服出的）</b><div className="lp-samples">{state!.samples.map(src => <img key={src} src={src.startsWith("/") ? src : assetUrl(src)} alt="" />)}</div></div>
            </div>
            <h4 className="lp-h">每类图怎么排、有没有人 <small>有人的图会用同一组模特；不对的直接改</small></h4>
            <div className="lp-learn-grid">{TASKS.map(t => {
              const base = learned.templates[t].square, tpl = people[t] ? withPeople(base, people[t]!.people, people[t]!.display) : base;
              return (<div key={t} className="lp-learn-t"><b>{TASK_LABEL[t]}</b><Wire template={tpl} width={110} />
                <select value={CHOICES.findIndex(c => c.people === tpl.people && (c.people > 0 || c.display === (tpl.display ?? "平铺")))} onChange={e => { const c = CHOICES[Number(e.target.value)]; setPeople(p => ({ ...p, [t]: { people: c.people, display: c.display } })); }}>
                  {CHOICES.map((c, i) => <option key={c.label} value={i}>{c.label}</option>)}</select></div>);
            })}</div>
          </>)}
          {step === "view" && !learned && <div className="lp-alert y">{state?.error ?? "没学成"}</div>}
        </div>
        <div className="lp-box-foot">
          {step === "upload" && <><div className="grow">{busy || (price ? <>学一次 <b>{price}</b> 积分，学完会用示例衣服出 3 张样图给你看；没学成不扣</> : "学完会用示例衣服出 3 张样图给你看")}</div>
            <button type="button" className="lp-btn" disabled={!!busy} onClick={onClose}>取消</button>
            <button type="button" className="lp-btn primary" disabled={!!busy || files.length < 3 || !name.trim()} onClick={() => void start()}>{files.length < 3 ? `至少 3 张图（还差 ${3 - files.length} 张）` : `开始学${price ? ` · ${price} 积分` : ""}`}</button></>}
          {step === "wait" && <><div className="grow">{price ? `已冻结 ${price} 积分；没学成会退回` : ""}</div><button type="button" className="lp-btn" onClick={onClose}>先关掉</button></>}
          {step === "view" && learned && <><div className="grow">满意就保存，团队里的人定方案时都能选它。</div>
            <button type="button" className="lp-btn" disabled={!!busy} onClick={() => void drop().then(onClose)}>不要了</button>
            <button type="button" className="lp-btn" disabled={!!busy} onClick={() => void relearn()}>换图重学{price ? ` · ${price} 积分` : ""}</button>
            <button type="button" className="lp-btn primary" disabled={!!busy} onClick={() => void save()}>保存到我的版式</button></>}
          {step === "view" && !learned && <><div className="grow" /><button type="button" className="lp-btn" onClick={() => void drop().then(onClose)}>关闭</button><button type="button" className="lp-btn primary" onClick={() => void relearn()}>换图重学</button></>}
        </div>
      </div>
    </div>
  );
}
