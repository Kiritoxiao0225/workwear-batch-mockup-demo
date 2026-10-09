"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图: drop product folders, the AI sorts each one, the user fixes the plan (定方案), the
 * square images are made first and changed on the 画板, then the 3:4 and 2:3 images follow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import type { Config, Detail, LayoutCard, SlotState, Summary } from "@/lib/listing/api-types";
import { api, downloadUrl, isDemo, post } from "@/lib/listing/client-api";
import { checkDraft, DEFAULT_COUNTS, type Counts, type Draft, type PriceLine } from "@/lib/listing/draft";
import { BUILT_IN_LAYOUTS } from "@/lib/listing/templates";
import { draftPrice, layoutOf, PlanDialog, PriceInfo, startDraft, type Prices } from "./listing-plan";
import { ResultsPanel } from "./listing-results";
import { CanvasEditor } from "./listing-canvas";
import { LearnDialog, MyLayouts } from "./listing-layouts";
import { ServiceDialog } from "./listing-service";
import "./listing-images.css";

const BUILT_IN: LayoutCard[] = BUILT_IN_LAYOUTS.map(l => ({ ...l, own: false }));
/** One dropped folder = one product. */
type Group = { name: string; files: { file: File; path: string }[] };
type Upload = { done: number; total: number; failed: number };
type Tab = "全部" | "待我处理" | "进行中" | "已完成";

const IMAGE = /\.(jpe?g|png|webp)$/i;
const SETTINGS_KEY = "listing-images-plan";
/**
 * Photos go up at most 2048 px on the long side as JPEG: the model never needs more, and an
 * 8 MB camera original becomes well under 1 MB. A small file, or one the browser cannot decode,
 * goes up unchanged.
 */
async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1_500_000) { bitmap.close(); return file; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }
}

/** Every image under each dropped folder; loose files become one product. */
async function groupsFromDrop(items: DataTransferItemList): Promise<Group[]> {
  const readAll = (reader: FileSystemDirectoryReader) => new Promise<FileSystemEntry[]>((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () => reader.readEntries(batch => { if (!batch.length) resolve(out); else { out.push(...batch); next(); } }, reject);
    next();
  });
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<Group["files"]> => {
    if (entry.isFile) {
      if (!IMAGE.test(entry.name) || entry.name.startsWith(".")) return [];
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      return [{ file, path: prefix + entry.name }];
    }
    const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    return (await Promise.all(children.map(child => walk(child, prefix + entry.name + "/")))).flat();
  };
  const entries = [...items].map(item => item.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  const groups: Group[] = [], loose: Group = { name: "未命名商品", files: [] };
  for (const entry of entries) {
    if (entry.isDirectory) {
      const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
      const files = (await Promise.all(children.map(child => walk(child, "")))).flat();
      if (files.length) groups.push({ name: entry.name, files });
    } else loose.files.push(...await walk(entry, ""));
  }
  if (loose.files.length) groups.push(loose);
  return groups;
}
function groupsFromInput(list: FileList): Group[] {
  const groups = new Map<string, Group>();
  for (const file of list) {
    if (!IMAGE.test(file.name)) continue;
    const parts = (file.webkitRelativePath || file.name).split("/");
    const name = parts.length > 1 ? parts[0] : "未命名商品";
    if (!groups.has(name)) groups.set(name, { name, files: [] });
    groups.get(name)!.files.push({ file, path: parts.slice(parts.length > 1 ? 1 : 0).join("/") });
  }
  return [...groups.values()];
}

const whenOf = (iso: string) => {
  const d = new Date(iso), now = new Date(), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400_000);
  return days === 0 ? `今天 ${hm}` : days === 1 ? `昨天 ${hm}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
};
/** Price lines of several products added up by kind, for the button that starts them all. */
const sumLines = (all: PriceLine[][]) => {
  const by = new Map<string, PriceLine>();
  for (const l of all.flat()) { const k = l.label + l.unit; const o = by.get(k); by.set(k, o ? { ...o, count: o.count + l.count, credits: o.credits + l.credits } : { ...l }); }
  return [...by.values()];
};

const STEPS = ["整理素材", "定方案", "出方图", "画板和竖版"];
type Stage = { step: number; c: "" | "b" | "g" | "y" | "r"; text: string };
function stageOf(p: Summary, upload: Upload | undefined, draft: Draft | null, layouts: LayoutCard[]): Stage {
  if (p.status === "uploading") return upload ? { step: 1, c: "", text: `上传中 ${upload.done}/${upload.total}${upload.failed ? `，${upload.failed} 张没传上` : ""}` } : { step: 1, c: "y", text: `已上传 ${p.images} 张，还没开始整理` };
  if (p.status === "planning") return { step: 1, c: "b", text: "AI 正在整理素材：去重、分类、读卖点、和竞品比一遍，约 1–2 分钟" };
  if (p.status === "failed") return { step: 1, c: "r", text: p.error || "整理没成功" };
  if (p.status === "materials") {
    if (!draft) return { step: 2, c: "b", text: "素材整理好了，等你定方案" };
    const k = checkDraft(draft, layoutOf(layouts, draft.layout));
    if (k.red.length) return { step: 2, c: "r", text: k.red[0] };
    if (p.error) return { step: 2, c: "y", text: p.error };
    return k.warn.length ? { step: 2, c: "y", text: `方案好了，第 ${k.warn.join("、")} 张有提醒，看一眼再出图` } : { step: 2, c: "g", text: "方案好了：看一眼卖点和每张图讲什么，就能出图" };
  }
  if (p.status === "generating") return p.round === 2 ? { step: 4, c: "b", text: `竖版出图中 ${p.made}/${p.slots}，做好的会陆续出现` } : { step: 3, c: "b", text: `出图中 ${p.made}/${p.slots}：先出定妆照和 1:1 方图` };
  if (p.status === "square") return { step: 4, c: "y", text: p.broken ? `方图做好了，${p.broken} 张没成功，可以重做；改满意后出竖版` : "方图出好了：在画板上改满意，再出竖版" };
  return p.broken ? { step: 4, c: "y", text: `做好 ${p.made}/${p.slots} 张，${p.broken} 张没成功，可以重做` } : { step: 5, c: "g", text: `全部做好了，共 ${p.made} 张` };
}

export function ListingImagesClient({ demo = false }: { demo?: boolean } = {}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [mine, setMine] = useState(false);
  const [service, setService] = useState(false);
  const [learning, setLearning] = useState<{ resume?: string; apply?: (id: string) => void } | null>(null);
  const [projects, setProjects] = useState<Summary[]>([]);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [uploads, setUploads] = useState<Record<string, Upload>>({});
  const [settings, setSettings] = useState<{ layout: string; counts: Counts }>({ layout: BUILT_IN[0].id, counts: DEFAULT_COUNTS });
  const [pending, setPending] = useState<Group[] | null>(null);
  const [over, setOver] = useState(false);
  const [planning, setPlanning] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [canvas, setCanvas] = useState<{ project: string; slot: string } | null>(null);
  const [tab, setTab] = useState<Tab>("全部");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, ms = 3200) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), ms); }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- localStorage and the server list exist only after mount. */
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); if (saved?.layout && saved?.counts && "long" in saved.counts) setSettings(saved); } catch { /* first visit */ }
    api<Config>("config").then(setConfig).catch(error => say(error.message));
  }, [say]);
  const refresh = useCallback(async () => {
    const list = await api<Summary[]>("projects");
    setProjects(list);
    // The plan page and the results need the product's material, plan and images.
    const needed = list.filter(p => ["materials", "generating", "square", "done"].includes(p.status));
    const loaded = await Promise.all(needed.map(p => api<Detail>("projects/" + p.id).catch(() => null)));
    setDetails(old => ({ ...old, ...Object.fromEntries(loaded.filter((d): d is Detail => !!d).map(d => [d.id, d])) }));
  }, []);
  useEffect(() => { refresh().catch(error => say(error.message)); }, [refresh, say]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const busy = projects.some(p => ["planning", "writing", "generating"].includes(p.status)) || Object.keys(uploads).length > 0;
  useEffect(() => { if (!busy) return; const t = setInterval(() => void refresh().catch(() => {}), 3000); return () => clearInterval(t); }, [busy, refresh]);

  const loadConfig = () => api<Config>("config").then(setConfig).catch(error => say((error as Error).message));
  const layouts = config?.layouts ?? BUILT_IN;
  const prices: Prices = { image: config?.imageCredits ?? 0, multi: config?.multiCredits ?? 0, exempt: !config || config.exempt };
  const plain = (id: string) => layoutOf(layouts, id);
  const draftOf = (id: string): Draft | null => {
    const d = details[id], p = projects.find(x => x.id === id);
    if (!d?.materials || !p) return null;
    return drafts[id] ?? startDraft(d.materials, plain(p.layout), settings.counts);
  };

  const startPlan = async (id: string) => {
    try { await post("projects/" + id + "/plan"); await refresh(); } catch (error) { say((error as Error).message); await refresh(); }
  };
  const startGroups = async (groups: Group[]) => {
    for (const group of groups) {
      const id = crypto.randomUUID();
      const layout = layouts.some(l => l.id === settings.layout) ? settings.layout : layouts[0].id;
      try { await post("projects", { id, name: group.name.slice(0, 120), layout, counts: settings.counts }); }
      catch (error) { say(`「${group.name}」没建成：${(error as Error).message}`); continue; }
      setUploads(u => ({ ...u, [id]: { done: 0, total: group.files.length, failed: 0 } }));
      await refresh();
      let next = 0, failed = 0;
      const why = new Map<string, number>();
      const worker = async () => {
        while (next < group.files.length) {
          const { file, path } = group.files[next++];
          try {
            await api(`projects/${id}/images`, { method: "POST", body: await shrink(file), headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-file-path": encodeURIComponent(path) } });
          } catch (error) { failed++; const reason = (error as Error).message.replace(/：.*$/, ""); why.set(reason, (why.get(reason) ?? 0) + 1); }
          setUploads(u => ({ ...u, [id]: { done: (u[id]?.done ?? 0) + 1, total: group.files.length, failed } }));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      setUploads(u => { const rest = { ...u }; delete rest[id]; return rest; });
      const reasons = [...why].map(([reason, n]) => `${reason}（${n} 张）`).join("；");
      if (failed === group.files.length) { say(`「${group.name}」一张都没传上：${reasons}`, 12000); await refresh(); continue; }
      if (failed) say(`「${group.name}」有 ${failed} 张没传上：${reasons}。其余 ${group.files.length - failed} 张照常整理`, 12000);
      await startPlan(id);
    }
  };
  const choose = (groups: Group[]) => { if (!groups.length) say("没有找到图片（只支持 JPG、PNG、WebP）"); else setPending(groups); };
  const onDrop = async (event: React.DragEvent) => { event.preventDefault(); setOver(false); choose(await groupsFromDrop(event.dataTransfer.items)); };
  const pick = useRef<HTMLInputElement>(null);

  /** Start generating from each plan; the layout and counts become the defaults for the next drop. */
  const start = async (ids: string[]) => {
    let ok = 0;
    for (const id of ids) {
      const draft = draftOf(id); if (!draft) continue;
      try {
        await post(`projects/${id}/start`, draft); ok++;
        const next = { layout: draft.layout, counts: draft.counts };
        setSettings(next); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* optional */ }
      } catch (error) { say(`「${projects.find(p => p.id === id)?.name}」：${(error as Error).message}`, 8000); }
    }
    await refresh();
    return ok;
  };
  const redo = async (id: string, slot: string, label: string) => {
    const note = window.prompt(`重做「${label}」。有补充要求可以写在这里（可不填）`, "");
    if (note === null) return;
    try {
      const r = await post<{ images: number }>(`projects/${id}/redo`, { slot, note });
      say(r.images > 1 ? `已重新排队 ${r.images} 张：这张和因为它没做出来的图` : "已重新排队"); await refresh();
    } catch (error) { say((error as Error).message); }
  };
  const verticals = async (id: string) => {
    try { await post(`projects/${id}/verticals`); say("竖版开始出了，做好的会陆续出现"); await refresh(); } catch (error) { say((error as Error).message); }
  };
  const remove = async (p: Summary) => {
    if (!window.confirm(`删除「${p.name}」？上传的图片和出好的图都会删掉。`)) return;
    try { await api("projects/" + p.id, { method: "DELETE" }); await refresh(); } catch (error) { say((error as Error).message); }
  };
  const open = async (id: string) => {
    if (!details[id]) { const d = await api<Detail>("projects/" + id).catch(() => null); if (d) setDetails(old => ({ ...old, [id]: d })); }
    setViewing(id);
  };

  const needsMe = (p: Summary) => ["materials", "failed", "square"].includes(p.status) || (p.status === "uploading" && !uploads[p.id] && p.images > 0);
  const running = (p: Summary) => ["planning", "writing", "generating"].includes(p.status) || !!uploads[p.id];
  const TABS: Record<Tab, (p: Summary) => boolean> = { 全部: () => true, 待我处理: needsMe, 进行中: running, 已完成: p => p.status === "done" };
  const ready = projects.filter(p => p.status === "materials" && draftOf(p.id) && !checkDraft(draftOf(p.id)!, plain(draftOf(p.id)!.layout)).red.length);
  const readyCost = ready.map(p => { const d = draftOf(p.id)!; return draftPrice(d, details[p.id].materials!, plain(d.layout), prices).now; });
  const readyLines = sumLines(readyCost.map(c => c.lines)), readyTotal = readyCost.reduce((n, c) => n + c.credits, 0);
  const done = projects.filter(p => p.status === "done");
  const planDetail = planning ? details[planning] : undefined, planDraft = planning ? draftOf(planning) : null;
  const viewDetail = viewing ? details[viewing] : undefined;
  const canvasDetail = canvas ? details[canvas.project] : undefined, canvasSlot = canvasDetail?.slots.find(x => x.slot === canvas?.slot);

  return (
    <>
      {demo ? <div className="lp-demo-bar">本地演示：数据是假的，不花钱、不存盘；图是自家测试款的真实出图，灰色「演示占位」图是还没出过的类型。刷新页面会回到初始状态。</div> : <AppHeader />}
      <main className="listing-page">
        <div className="lp-dropwrap">
          <button type="button" className={"lp-drop" + (over ? " over" : "")}
            onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} onClick={() => pick.current?.click()}>
            <b>拖入商品文件夹</b>
            可以一次拖多个，每个文件夹一款，里面的图随便放 · AI 先整理素材{config && !config.exempt && <>，每款 {config.planCredits} 积分</>}
          </button>
          {pending && <div className="lp-confirm">识别到 <b>{pending.length} 款</b>：{pending.map(g => g.name).join("、")}{config && !config.exempt && <> · 整理素材共 <b>{config.planCredits * pending.length}</b> 积分</>}
            <button type="button" className="lp-btn sm primary" onClick={() => { const g = pending; setPending(null); void startGroups(g); }}>开始整理</button>
            <button type="button" className="lp-btn sm" onClick={() => setPending(null)}>取消</button></div>}
        </div>
        <input ref={pick} type="file" multiple hidden {...{ webkitdirectory: "" }} accept="image/*"
          onChange={e => { const g = groupsFromInput(e.target.files!); e.target.value = ""; choose(g); }} />

        <div className="lp-filters">{(Object.keys(TABS) as Tab[]).map(t => {
          const n = projects.filter(TABS[t]).length;
          return <button type="button" key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t} {t === "待我处理" && n ? <b>{n}</b> : n}</button>;
        })}
          <span className="grow" />
          <button type="button" className="lp-btn sm" onClick={() => setService(true)}>店铺服务</button>
          {tab === "待我处理" && ready.length > 0 && <>
            <button type="button" className="lp-btn sm primary" onClick={() => void start(ready.map(p => p.id)).then(n => say(`${n} 款开始出图，做好的会陆续出现`))}>按 AI 方案全部开始出图（{ready.length} 款{prices.exempt ? "" : `，约 ${readyTotal} 积分`}）</button>
            {!prices.exempt && <PriceInfo lines={readyLines} total={readyTotal} extra={`${ready.length} 款合计，有红色问题的不算在内`} />}</>}
          {tab === "已完成" && done.length > 0 && <button type="button" className="lp-btn sm" onClick={() => isDemo() ? say("演示页不能下载") : done.forEach((p, i) => setTimeout(() => { const a = document.createElement("a"); a.href = downloadUrl(p.id); a.click(); }, i * 1200))}>全部下载（{done.length} 款）</button>}
        </div>
        {!projects.length && <div className="lp-card lp-empty">还没有商品。把一个商品的主图、SKU 图、详情图放进同一个文件夹，拖到上面。</div>}
        <div className="lp-list">{projects.filter(TABS[tab]).map(p => {
          const draft = p.status === "materials" ? draftOf(p.id) : null, s = stageOf(p, uploads[p.id], draft, layouts);
          const cost = draft && details[p.id]?.materials && !prices.exempt ? draftPrice(draft, details[p.id].materials!, plain(draft.layout), prices).now : null;
          return (
            <div key={p.id} className={"lp-card lp-row" + (s.c === "r" ? " red" : s.c === "y" ? " att" : "")}>
              {p.cover ? <img className="th" src={p.cover} alt="" /> : <div className="th">{p.name.slice(0, 1)}</div>}
              <div className="nm"><b title={p.name}>{p.name}</b><small>{whenOf(p.created_at)} 拖入 · {layouts.find(l => l.id === p.layout)?.name ?? "已删除的版式"}</small></div>
              <div className="mid">
                <div className="lp-steps">{STEPS.map((n, i) => <span key={n} className={i + 1 < s.step ? "done" : i + 1 === s.step ? "now" + (s.c === "r" ? " r" : "") : ""}>{i + 1 < s.step ? "✓ " : ""}{n}</span>)}</div>
                <div className={"lp-st " + s.c}>{s.text}</div>
              </div>
              <div className="acts">
                {p.status === "materials" && <button type="button" className="lp-btn sm primary" onClick={() => setPlanning(p.id)}>{s.c === "r" ? "去处理" : "定方案"}</button>}
                {cost && <><span className="lp-muted lp-small">先出方图约 {cost.credits} 积分</span><PriceInfo lines={cost.lines} total={cost.credits} extra="分析费已在整理时扣过；竖版以后出、以后扣" /></>}
                {(p.status === "failed" || (p.status === "uploading" && !uploads[p.id] && p.images > 0)) && <button type="button" className="lp-btn sm primary" onClick={() => void startPlan(p.id)}>{p.status === "failed" ? "重新整理" : "开始整理"}</button>}
                {p.status === "generating" && <button type="button" className="lp-btn sm" onClick={() => void open(p.id)}>看进度</button>}
                {p.status === "square" && <><button type="button" className="lp-btn sm primary" onClick={() => void open(p.id)}>看图、改图</button><button type="button" className="lp-btn sm" onClick={() => void verticals(p.id)}>出竖版</button></>}
                {p.status === "done" && <><button type="button" className="lp-btn sm primary" onClick={() => void open(p.id)}>看图</button><a className="lp-btn sm" href={downloadUrl(p.id)} onClick={e => { if (isDemo()) { e.preventDefault(); say("演示页不能下载"); } }}>下载</a></>}
                {!running(p) && <button type="button" className="lp-btn sm ghost" onClick={() => void remove(p)}>删除</button>}
              </div>
            </div>);
        })}</div>
      </main>
      {planning && planDetail?.materials && planDraft && <PlanDialog name={planDetail.name} materials={planDetail.materials} sources={planDetail.sources} draft={planDraft} layouts={layouts} prices={prices}
        onChange={d => setDrafts(x => ({ ...x, [planning]: d }))}
        onUpload={async file => {
          try {
            const added = await api<{ label: string; url: string }>(`projects/${planning}/extra`, { method: "POST", body: await shrink(file), headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
            const d = await api<Detail>("projects/" + planning); setDetails(o => ({ ...o, [planning]: d }));
            return added;
          } catch (error) { say((error as Error).message); throw error; }
        }}
        onLearn={() => { const id = planning; setLearning({ apply: layout => setDrafts(x => ({ ...x, [id]: { ...(x[id] ?? draftOf(id)!), layout } })) }); }}
        onManage={() => { void loadConfig(); setMine(true); }}
        onService={() => setService(true)}
        onClose={() => setPlanning(null)}
        onStart={async () => { if (await start([planning])) { setPlanning(null); say("AI 正在写每张图的画面，写完马上开始出图"); } }} />}
      {viewing && viewDetail && <ResultsPanel detail={viewDetail} layouts={layouts} prices={prices}
        onCanvas={(x: SlotState) => setCanvas({ project: viewing, slot: x.slot })} onRedo={(slot, label) => void redo(viewing, slot, label)}
        onDone={async message => { say(message); await refresh(); }} onError={say} onClose={() => setViewing(null)} />}
      {canvasDetail && canvasSlot && <CanvasEditor key={canvasSlot.slot + (canvasSlot.image ?? "")} detail={canvasDetail} slot={canvasSlot} layout={plain(canvasDetail.plan?.layout ?? canvasDetail.layout)} unit={prices.image} exempt={prices.exempt}
        onClose={() => setCanvas(null)} onDone={async message => { say(message); await refresh(); }} onError={say} />}
      {mine && <MyLayouts layouts={layouts} learning={config?.learning ?? []} onClose={() => setMine(false)} onLearn={resume => setLearning({ resume })} onError={say}
        onDeleted={async name => { say(`已删除「${name}」，用它出过的图不受影响`); await loadConfig(); }} />}
      {learning && <LearnDialog resume={learning.resume} price={config?.exempt ? 0 : config?.layoutCredits ?? 0} shrink={shrink} onError={say}
        onClose={() => { setLearning(null); void loadConfig(); }}
        onSaved={async (id, name) => { await loadConfig(); learning.apply?.(id); setLearning(null); say(learning.apply ? `已保存「${name}」，并给这一款用上了` : `已保存「${name}」，团队里的人定方案时都能选`); }} />}
      {service && <ServiceDialog unit={prices.image} exempt={prices.exempt} onClose={() => setService(false)} onSay={say} />}
      {toast && <div className="lp-toast" role="status">{toast}</div>}
    </>
  );
}
