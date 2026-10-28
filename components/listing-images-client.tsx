"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
/**
 * 电商主图: drop product folders, the AI sorts each one, the user fixes the plan (定方案), the
 * square images are made first and changed one by one, then the 3:4 and 2:3 images follow. Beside
 * the 工作台 are the 母版库 (the shop's default master) and the 店铺设置 (its service images).
 */
import { PLAN_IMAGE_COST_MICRO, planCredits } from "@/lib/listing/plan-price";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AppHeader } from "./app-header";
import { STORAGE_PAGE, useStorage } from "@/lib/storage-status";
import { PageHeader, PageTabs } from "./page-header";
import type { Config, Detail, LayoutCard, Sorted, Summary } from "@/lib/listing/api-types";
import { api, assetUrl, downloadUrl, isDemo, post } from "@/lib/listing/client-api";
import { shrink } from "@/lib/listing/shrink";
import { checkDraft, DEFAULT_COUNTS, fillParts, type Counts, type Draft, type PriceLine } from "@/lib/listing/draft";
import { BUILT_IN_LAYOUTS } from "@/lib/listing/templates";
import { draftPrice, layoutOf, lookMaster, PlanDialog, PriceInfo, startDraft, type Prices } from "./listing-plan";
import { CopyDialog } from "./listing-copy";
import { ResultsPanel } from "./listing-results";
import { editsSummary } from "./listing-edits";
import { ServiceTip, ShopPage } from "./listing-service";
import "./listing-images.css";

const BUILT_IN: LayoutCard[] = BUILT_IN_LAYOUTS.map(l => ({ ...l, own: false }));
/** One dropped folder = one product. */
type Group = { name: string; files: { file: File; path: string }[] };
/** Above this many photos the analysis runs in several parts and takes a while: said before it starts. */
const BIG_FOLDER = 150;
type Upload = { done: number; total: number; failed: number };
type Tab = "全部" | "待我处理" | "进行中" | "已完成";

const IMAGE = /\.(jpe?g|png|webp)$/i;
const SETTINGS_KEY = "listing-images-plan";
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

const STEPS = ["整理素材", "定方案", "出方图", "改图和竖版"];
type Stage = { step: number; c: "" | "b" | "g" | "y" | "r"; text: string };
function stageOf(p: Summary, upload: Upload | undefined, draft: Draft | null, layouts: LayoutCard[], images?: Sorted[]): Stage {
  if (p.status === "uploading") return upload ? { step: 1, c: "", text: `上传中 ${upload.done}/${upload.total}${upload.failed ? `，${upload.failed} 张没传上` : ""}` } : { step: 1, c: "y", text: `已上传 ${p.images} 张，还没开始整理` };
  if (p.status === "planning") return { step: 1, c: "b", text: "AI 正在整理素材：去重、分类、读卖点、和竞品比一遍，约 1–2 分钟" };
  if (p.status === "failed") return { step: 1, c: "r", text: p.error || "整理没成功" };
  if (p.status === "materials") {
    if (!draft) return { step: 2, c: "b", text: "素材整理好了，等你定方案" };
    const k = checkDraft(draft, layoutOf(layouts, draft.layout), images);
    if (k.red.length) return { step: 2, c: "r", text: k.red[0] };
    if (p.error) return { step: 2, c: "y", text: p.error };
    return k.warn.length ? { step: 2, c: "y", text: `方案好了，第 ${k.warn.join("、")} 张有提醒，看一眼再出图` } : { step: 2, c: "g", text: "方案好了：看一眼卖点和每张图讲什么，就能出图" };
  }
  if (p.status === "writing") return { step: 3, c: "b", text: "AI 正在写每张图的画面，约 1 分钟，写完自动开始出图" };
  if (p.status === "generating") return p.round === 2 ? { step: 4, c: "b", text: `竖版出图中 ${p.made}/${p.slots}，做好的会陆续出现` } : { step: 3, c: "b", text: `出图中 ${p.made}/${p.slots}：先出定妆照和 1:1 方图` };
  if (p.status === "square") return { step: 4, c: "y", text: p.broken ? `方图做好了，${p.broken} 张没成功，可以重新生成；改满意后出竖版` : "方图出好了：哪张不满意点开改，满意了再出竖版" };
  return p.broken ? { step: 4, c: "y", text: `做好 ${p.made}/${p.slots} 张，${p.broken} 张没成功，可以重新生成` } : { step: 5, c: "g", text: `全部做好了，共 ${p.made} 张` };
}

const VIEWS = [["home", "工作台"], ["shop", "店铺设置"]] as const;
const VIEW_INTRO: Record<(typeof VIEWS)[number][0], string> = {
  home: "拖入商品文件夹，AI 整理素材、排好方案，你确认后出图。",
  shop: "这里只放店铺的服务：写一次，每款出图都会用到。",
};

export function ListingImagesClient({ demo = false }: { demo?: boolean } = {}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [view, setView] = useState<(typeof VIEWS)[number][0]>("home");
  const [projects, setProjects] = useState<Summary[]>([]);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [uploads, setUploads] = useState<Record<string, Upload>>({});
  const [settings, setSettings] = useState<{ counts: Counts }>({ counts: DEFAULT_COUNTS });
  const [pending, setPending] = useState<Group[] | null>(null);
  const [over, setOver] = useState(false);
  const [planning, setPlanning] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("全部");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, ms = 3200) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), ms); }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- localStorage and the server list exist only after mount. */
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); if (saved?.counts && "long" in saved.counts) setSettings({ counts: saved.counts }); } catch { /* first visit */ }
    api<Config>("config").then(setConfig).catch(error => say(error.message));
  }, [say]);
  // What each product looked like at the last refresh, so the background poll can skip idle ones.
  const seen = useRef<Record<string, string>>({});
  /**
   * full: every product's detail (on load and after any action). The background poll passes false
   * and reloads only products still generating or whose status changed since the last look.
   */
  const refresh = useCallback(async (full = true) => {
    const list = await api<Summary[]>("projects");
    const before = seen.current;
    seen.current = Object.fromEntries(list.map(p => [p.id, `${p.status}|${p.updated_at}|${p.made}|${p.broken}|${JSON.stringify(p.edits ?? null)}`]));
    setProjects(list);
    // The plan page and the results need the product's material, plan and images.
    const needed = list.filter(p => ["materials", "generating", "square", "done"].includes(p.status)
      && (full || p.status === "generating" || !!p.edits?.running || before[p.id] !== seen.current[p.id]));
    const loaded = await Promise.all(needed.map(p => api<Detail>("projects/" + p.id).catch(() => null)));
    setDetails(old => ({ ...old, ...Object.fromEntries(loaded.filter((d): d is Detail => !!d).map(d => [d.id, d])) }));
  }, []);
  useEffect(() => { refresh().catch(error => say(error.message)); }, [refresh, say]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // A 「点图修改」 being made keeps the page polling too, so its image and 「改图进度」 change when it is done.
  const busy = projects.some(p => ["planning", "writing", "generating"].includes(p.status) || !!p.edits?.running) || Object.keys(uploads).length > 0;
  useEffect(() => { if (!busy) return; const t = setInterval(() => void refresh(false).catch(() => {}), 3000); return () => clearInterval(t); }, [busy, refresh]);

  const layouts = config?.layouts ?? BUILT_IN;
  const prices: Prices = { image: config?.imageCredits ?? 0, multi: config?.multiCredits ?? 0, exempt: !config || config.exempt };
  const plain = (id: string) => layoutOf(layouts, id);
  const draftOf = (id: string): Draft | null => {
    const d = details[id], p = projects.find(x => x.id === id);
    if (!d?.materials || !p) return null;
    // Settled on the way in too: a plan kept from before still gets its part photos (or another way to draw a missing part).
    return drafts[id] ? fillParts(drafts[id], d.materials.sorted.images) : startDraft(d.materials, plain(lookMaster(d.materials, p.layout)), settings.counts);
  };

  const startPlan = async (id: string) => {
    try { await post("projects/" + id + "/plan"); await refresh(); } catch (error) { say((error as Error).message); await refresh(); }
  };
  const startGroups = async (groups: Group[]) => {
    for (const group of groups) {
      const id = crypto.randomUUID();
      // The master is the AI's pick once the material is sorted; this one only stands until then.
      try { await post("projects", { id, name: group.name.slice(0, 120), layout: BUILT_IN[0].id, counts: settings.counts }); }
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
  // Space used up: new folders would be refused picture by picture, so stop at the door (10-28).
  const storageFull = useStorage().level === "full" && !isDemo();
  const choose = (groups: Group[]) => { if (storageFull) say("存储空间已满，先到「存储空间」删掉不用的商品", 6000); else if (!groups.length) say("没有找到图片（只支持 JPG、PNG、WebP）"); else setPending(groups); };
  const onDrop = async (event: React.DragEvent) => { event.preventDefault(); setOver(false); choose(await groupsFromDrop(event.dataTransfer.items)); };
  const pick = useRef<HTMLInputElement>(null);

  const keep = (next: { counts: Counts }) => { setSettings(next); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* optional */ } };
  /** Start generating from each plan; its counts become the defaults for the next drop (the master is the AI's pick per product). */
  const start = async (ids: string[]) => {
    let ok = 0;
    for (const id of ids) {
      const draft = draftOf(id); if (!draft) continue;
      try {
        await post(`projects/${id}/start`, draft); ok++;
        keep({ counts: draft.counts });
      } catch (error) { say(`「${projects.find(p => p.id === id)?.name}」：${(error as Error).message}`, 8000); }
    }
    await refresh();
    return ok;
  };
  const redo = async (id: string, slot: string, label: string) => {
    const note = window.prompt(`重新生成「${label}」。有补充要求可以写在这里（可不填）`, "");
    if (note === null) return;
    try {
      const r = await post<{ images: number }>(`projects/${id}/redo`, { slot, note });
      say(r.images > 1 ? `已重新排队 ${r.images} 张：这张和因为它没做出来的图` : "已重新排队"); await refresh();
    } catch (error) { say((error as Error).message); }
  };
  /**
   * 「全部下载」: one zip with a folder per product, packed in the browser from each product's own
   * download so the server never holds several products' images at once.
   */
  const [zipping, setZipping] = useState(false);
  const downloadAll = async (list: Summary[]) => {
    if (isDemo()) { say("演示页不能下载"); return; }
    setZipping(true);
    try {
      const { default: JSZip } = await import("jszip");
      const all = new JSZip(), used = new Set<string>();
      let failed = 0;
      for (const [i, p] of list.entries()) {
        say(`正在打包第 ${i + 1} / ${list.length} 款…`, 120000);
        const response = await fetch(downloadUrl(p.id), { cache: "no-store" });
        if (!response.ok) { failed++; continue; }
        const one = await JSZip.loadAsync(await response.arrayBuffer());
        const base = p.name.replace(/[\\/:*?"<>|]/g, "_") || "未命名";
        let folder = base;
        for (let n = 2; used.has(folder); n++) folder = `${base} (${n})`;
        used.add(folder);
        for (const [path, entry] of Object.entries(one.files)) if (!entry.dir) all.file(`${folder}/${path}`, await entry.async("blob"));
      }
      if (!used.size) throw new Error("没有能下载的图");
      const url = URL.createObjectURL(await all.generateAsync({ type: "blob" }));
      const a = document.createElement("a");
      a.href = url; a.download = `电商主图-${used.size}款.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      say(failed ? `已打包 ${used.size} 款；${failed} 款没取到，可以单独下载` : `已打包 ${used.size} 款`);
    } catch (error) { say((error as Error).message); }
    finally { setZipping(false); }
  };
  /**
   * 「用这份素材再出一套」: the server makes a product per master from this one's material; with
   * `direct` each starts at once on its default plan (as 「按 AI 方案全部开始出图」 would), except
   * one whose plan has a red problem, which waits at 「定方案」.
   */
  const copy = async (id: string, picked: string[], direct: boolean) => {
    const source = projects.find(x => x.id === id);
    try {
      const made = (await post<{ projects: { id: string; name: string; layout: string }[] }>(`projects/${id}/copies`, { layouts: picked })).projects;
      let started = 0;
      const wait: string[] = [];
      if (direct) for (const x of made) {
        try {
          const d = await api<Detail>("projects/" + x.id);
          const draft = startDraft(d.materials!, plain(x.layout), source?.counts ?? settings.counts);
          if (checkDraft(draft, plain(draft.layout), d.materials!.sorted.images).red.length) { wait.push(x.name); continue; }
          await post(`projects/${x.id}/start`, draft); started++;
        } catch (error) { wait.push(`${x.name}（${(error as Error).message}）`); }
      }
      setCopying(null);
      await refresh();
      say(!direct ? `再出了 ${made.length} 套，在列表里点「定方案」看一眼再出图`
        : wait.length ? `再出了 ${made.length} 套，${started} 套已开始出图；${wait.join("、")}要先在「定方案」里处理` : `再出了 ${made.length} 套，都已开始出图，做好的会陆续出现`, 8000);
    } catch (error) { say((error as Error).message, 8000); await refresh(); }
  };
  const remove = async (p: Summary) => {
    if (!window.confirm(`删除「${p.name}」？上传的图片和出好的图都会删掉。`)) return;
    try { await api("projects/" + p.id, { method: "DELETE" }); await refresh(); } catch (error) { say((error as Error).message); }
  };
  const open = async (id: string) => {
    if (!details[id]) { const d = await api<Detail>("projects/" + id).catch(() => null); if (d) setDetails(old => ({ ...old, [id]: d })); }
    setViewing(id);
  };

  const needsMe = (p: Summary) => ["materials", "failed", "square"].includes(p.status) || (p.status === "uploading" && !uploads[p.id] && p.images > 0) || !!p.edits?.ready || !!p.edits?.failed;
  const running = (p: Summary) => ["planning", "writing", "generating"].includes(p.status) || !!uploads[p.id] || !!p.edits?.running;
  const TABS: Record<Tab, (p: Summary) => boolean> = { 全部: () => true, 待我处理: needsMe, 进行中: running, 已完成: p => p.status === "done" };
  const ready = projects.filter(p => p.status === "materials" && draftOf(p.id) && !checkDraft(draftOf(p.id)!, plain(draftOf(p.id)!.layout), details[p.id]?.materials?.sorted.images).red.length);
  const readyCost = ready.map(p => { const d = draftOf(p.id)!; return draftPrice(d, details[p.id].materials!, plain(d.layout), prices).now; });
  const readyLines = sumLines(readyCost.map(c => c.lines)), readyTotal = readyCost.reduce((n, c) => n + c.credits, 0);
  const done = projects.filter(p => p.status === "done");
  const planDetail = planning ? details[planning] : undefined, planDraft = planning ? draftOf(planning) : null;
  const viewDetail = viewing ? details[viewing] : undefined;

  return (
    <>
      {demo ? <div className="lp-demo-bar">本地演示：数据是假的，不花钱、不存盘；图是自家测试款的真实出图，灰色「演示占位」图是还没出过的类型。刷新页面会回到初始状态。</div> : <AppHeader />}
      <main className="listing-page page-frame">
        <PageHeader title="电商主图" description={VIEW_INTRO[view]}>
          <PageTabs label="电商主图" tabs={VIEWS} value={view} onChange={setView} />
        </PageHeader>
        {view === "shop" ? <ShopPage unit={prices.image} exempt={prices.exempt} onSay={say} /> : <>
        <div className="lp-dropwrap">
          <button type="button" className={"lp-drop" + (over ? " over" : "")}
            onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} onClick={() => storageFull ? choose([]) : pick.current?.click()}>
            <span className="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 10v6M9 13l3-3 3 3" /></svg></span>
            <span className="tx"><b>把商品文件夹拖到这里</b><span>一个文件夹一款，主图、SKU 图、详情图随便放。可以一次拖多个{config && !config.exempt && <> · 整理素材按张数算：每款 {config.planCredits} 积分起，每张图再加 {PLAN_IMAGE_COST_MICRO * config.planMultiplierMilli / 1e6} 积分</>}</span></span>
            <span className="lp-btn">选择文件夹</span>
          </button>
          {storageFull && <div className="lp-confirm">存储空间已满，新的素材传不上去。<Link href={STORAGE_PAGE}>去「存储空间」删掉不用的商品 ›</Link></div>}
          {pending && <div className="lp-confirm">识别到 <b>{pending.length} 款</b>：{pending.map(g => g.name).join("、")}{config && !config.exempt && <> · 整理素材共 <b>{pending.reduce((n, g) => n + planCredits(config.planCostMicro, config.planMultiplierMilli, g.files.length), 0)}</b> 积分{pending.length > 1 ? `（${pending.map(g => `${g.name} ${g.files.length} 张 ${planCredits(config.planCostMicro, config.planMultiplierMilli, g.files.length)}`).join("、")}）` : `（${pending[0].files.length} 张）`}</>}
            {pending.some(g => g.files.length > BIG_FOLDER) && <> · {pending.filter(g => g.files.length > BIG_FOLDER).map(g => `${g.name} 有 ${g.files.length} 张`).join("、")}，素材较多，会分几段整理，慢一些；中途断了可以接着做</>}
            <button type="button" className="lp-btn sm primary" disabled={storageFull} onClick={() => { const g = pending; setPending(null); void startGroups(g); }}>开始整理</button>
            <button type="button" className="lp-btn sm" onClick={() => setPending(null)}>取消</button></div>}
        </div>
        <input ref={pick} type="file" multiple hidden {...{ webkitdirectory: "" }} accept="image/*"
          onChange={e => { const g = groupsFromInput(e.target.files!); e.target.value = ""; choose(g); }} />
        <ServiceTip onOpen={() => setView("shop")} />

        {projects.length > 0 && <div className="lp-filters"><div className="lp-seg">{(Object.keys(TABS) as Tab[]).map(t => {
          const n = projects.filter(TABS[t]).length;
          return <button type="button" key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}<b className={t === "待我处理" && n ? "hot" : ""}>{n}</b></button>;
        })}</div>
          <span className="grow" />
          {tab === "待我处理" && ready.length > 0 && <>
            <button type="button" className="lp-btn sm primary" onClick={() => void start(ready.map(p => p.id)).then(n => say(`${n} 款开始出图，做好的会陆续出现`))}>按 AI 方案全部开始出图（{ready.length} 款{prices.exempt ? "" : `，约 ${readyTotal} 积分`}）</button>
            {!prices.exempt && <PriceInfo lines={readyLines} total={readyTotal} extra={`${ready.length} 款合计，有红色问题的不算在内`} />}</>}
          {tab === "已完成" && done.length > 0 && <button type="button" className="lp-btn sm" disabled={zipping} onClick={() => void downloadAll(done)}>{zipping ? "正在打包…" : `全部下载（${done.length} 款，一个压缩包）`}</button>}
        </div>}
        <div className="lp-list">{projects.filter(TABS[tab]).map(p => {
          const draft = p.status === "materials" ? draftOf(p.id) : null, s = stageOf(p, uploads[p.id], draft, layouts, details[p.id]?.materials?.sorted.images);
          const cost = draft && details[p.id]?.materials && !prices.exempt ? draftPrice(draft, details[p.id].materials!, plain(draft.layout), prices).now : null;
          const master = layouts.find(l => l.id === (draft?.layout ?? p.layout))?.name.split(" · ")[0] ?? "已删除的版式";
          const squares = (details[p.id]?.slots ?? []).filter(x => /^square:\d+$/.test(x.slot)).sort((a, b) => Number(a.slot.slice(7)) - Number(b.slot.slice(7))).slice(0, 5);
          return (
            <div key={p.id} className={"lp-card lp-row" + (s.c === "r" ? " red" : s.c === "y" ? " att" : "")}>
              {p.cover ? <img className="th" src={p.cover} alt="" /> : <div className="th">{p.name.slice(0, 1)}</div>}
              <div className="nm"><b title={p.name}>{p.name}</b><small>{p.status === "uploading" || p.status === "planning" ? `${whenOf(p.created_at)} 拖入 · ${p.images} 张素材` : `冲锋衣 · ${master} · ${whenOf(p.created_at)} 拖入`}</small></div>
              <div className="mid">
                <div className="lp-bars" role="img" aria-label={s.step > 4 ? "4 步都做完了" : `第 ${s.step} 步，共 4 步：${STEPS[s.step - 1]}`}>{STEPS.map((n, i) => <i key={n} title={n} className={i + 1 < s.step ? "d" : i + 1 === s.step ? "n" + (s.c === "r" ? " r" : "") : ""} />)}</div>
                <div className={"lp-st " + s.c}><span className="dot" />{s.text}</div>
                {p.edits && editsSummary(p.edits) && <button type="button" className={"lp-st-edits" + (p.edits.running ? " b" : p.edits.ready ? " g" : " r")} onClick={() => void open(p.id)}>改图：{editsSummary(p.edits)}</button>}
              </div>
              <div className="thumbs">{squares.map(x => x.image ? <img key={x.slot} src={assetUrl(x.image)} alt="" loading="lazy" /> : <span key={x.slot} className={"ph" + (x.status === "failed" ? " bad" : " ld")} title={x.status === "failed" ? "没做出来" : "出图中"} />)}</div>
              <div className="acts">
                {p.status === "materials" && <button type="button" className="lp-btn sm primary" onClick={() => setPlanning(p.id)}>{s.c === "r" ? "去处理" : "定方案"}</button>}
                {cost && <><span className="lp-muted lp-small">先出方图约 {cost.credits} 积分</span><PriceInfo lines={cost.lines} total={cost.credits} extra="分析费已在整理时扣过；竖版以后出、以后扣" /></>}
                {(p.status === "failed" || (p.status === "uploading" && !uploads[p.id] && p.images > 0)) && <button type="button" className="lp-btn sm primary" onClick={() => void startPlan(p.id)}>{p.status === "failed" ? (p.error?.includes("继续整理") ? "继续整理" : "重新整理") : "开始整理"}</button>}
                {p.status === "generating" && <button type="button" className="lp-btn sm" onClick={() => void open(p.id)}>看进度</button>}
                {p.status === "square" && <button type="button" className="lp-btn sm primary" onClick={() => void open(p.id)}>看图</button>}
                {p.status === "done" && <><button type="button" className="lp-btn sm primary" onClick={() => void open(p.id)}>看图</button><a className="lp-btn sm" href={downloadUrl(p.id)} onClick={e => { if (isDemo()) { e.preventDefault(); say("演示页不能下载"); } }}>下载</a></>}
                {["materials", "square", "done"].includes(p.status) && !p.sources_cleared_at && !isDemo() && <button type="button" className="lp-btn sm" onClick={() => setCopying(p.id)}>再出一套</button>}
                {!running(p) && <button type="button" className="lp-btn sm ghost" onClick={() => void remove(p)}>删除</button>}
              </div>
            </div>);
        })}</div>
        </>}
      </main>
      {planning && planDetail?.materials && planDraft && <PlanDialog projectId={planning} name={planDetail.name} materials={planDetail.materials} sources={planDetail.sources} draft={planDraft} layouts={layouts} prices={prices}
        onChange={d => setDrafts(x => ({ ...x, [planning]: d }))}
        onUpload={async (file, liner) => {
          try {
            // A liner photo (10-22) says what it is, so the plan counts it as that liner worn alone.
            const tag: Record<string, string> = liner ? { "x-liner-inner": encodeURIComponent(liner.inner), "x-liner-color": encodeURIComponent(liner.color) } : {};
            const added = await api<{ label: string; url: string }>(`projects/${planning}/extra`, { method: "POST", body: await shrink(file), headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), ...tag } });
            const d = await api<Detail>("projects/" + planning); setDetails(o => ({ ...o, [planning]: d }));
            return added;
          } catch (error) { say((error as Error).message); throw error; }
        }}
        onRefresh={async () => { const d = await api<Detail>("projects/" + planning); setDetails(o => ({ ...o, [planning]: d })); }}
        onService={() => { setPlanning(null); setView("shop"); }}
        onClose={() => setPlanning(null)}
        onStart={async () => { if (await start([planning])) { setPlanning(null); say("AI 正在写每张图的画面，写完马上开始出图"); } }} />}
      {viewing && viewDetail && <ResultsPanel detail={viewDetail} layouts={layouts} prices={prices}
        onRedo={(slot, label) => void redo(viewing, slot, label)}
        onDone={async message => { say(message); await refresh(); }} onError={say} onClose={() => setViewing(null)} />}
      {copying && <CopyDialog name={projects.find(p => p.id === copying)?.name ?? ""} current={draftOf(copying)?.layout ?? projects.find(p => p.id === copying)?.layout ?? ""}
        layouts={layouts} onCopy={(picked, direct) => copy(copying, picked, direct)} onClose={() => setCopying(null)} />}
      {toast && <div className="lp-toast" role="status">{toast}</div>}
    </>
  );
}
