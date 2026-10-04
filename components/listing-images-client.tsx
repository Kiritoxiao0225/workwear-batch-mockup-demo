"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import { ASSET_ROLES, DEFAULT_COUNTS, LISTING_LAYOUTS, type AssetRole, type ListingCounts } from "@/lib/listing/layouts";
import "./listing-images.css";

type Summary = { id: string; name: string; layout: string; counts: ListingCounts; status: "uploading" | "planning" | "review" | "confirmed" | "failed" | "generating" | "done"; error: string | null; images: number; cover: string | null; slots: number; made: number; broken: number; updated_at: string; sources_cleared_at: string | null };
type Slot = { n: number; role: string; title: string; subtitle: string; bullets: string[]; scene: string };
type Plan = {
  plan: {
    assets: { id: string; role: AssetRole; color: string; reason: string }[];
    product: { name: string; garment: string[]; colors: { name: string; hex: string; sku: string }[] };
    sellingPoints: { id: string; text: string; type: string }[];
    main: { square: Slot[]; portrait: Slot[]; poster: Slot[] };
  };
  corrected: string[]; problems: string[];
};
type Words = { title: string; subtitle: string; bullets: string[]; scene?: string };
type Review = { roles: Record<string, AssetRole>; colors: { sku: string; name: string }[]; slots: Record<string, Words> };
type SlotState = { slot: string; status: string; error: string | null; image: string | null; versions: number; history: { id: string; words: Words | null }[]; words: Words | null; input: { kind: string; skus?: string[]; slot?: { role: string; title: string } } };
type Detail = Summary & { images: { id: string; label: string; name: string; path: string; shape: string; url: string }[]; plan: Plan | null; review: Review | null; estimate: { images: number; credits: number } | null; slots: SlotState[] };
/** One dropped folder = one product; the upload dialog fills in its layout and counts. */
type Group = { name: string; files: { file: File; path: string }[]; layout?: string; counts?: ListingCounts };

const IMAGE = /\.(jpe?g|png|webp)$/i;
const SETTINGS_KEY = "listing-images-plan";
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch("/api/listing/" + path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
};
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
const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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

const statusOf = (p: Summary, upload?: { done: number; total: number; failed: number }, detail?: Detail): { c: string; text: string } => {
  if (p.status === "uploading") return upload ? { c: "", text: `上传中 ${upload.done}/${upload.total}${upload.failed ? `，${upload.failed} 张没传上` : ""}` } : { c: "y", text: `已上传 ${p.images} 张，还没开始分析` };
  if (p.status === "planning") return { c: "", text: "AI 正在读商品、给图片分类，约 1 分钟" };
  if (p.status === "failed") return { c: "r", text: p.error || "分析失败" };
  if (p.status === "confirmed") return { c: "b", text: "已确认，可以开始出图" };
  if (p.status === "generating") return { c: "", text: `出图中 ${p.made}/${p.slots}，每张约 1 分钟` };
  if (p.status === "done") return p.broken ? { c: "y", text: `完成 ${p.made}/${p.slots} · ${p.broken} 张没成功，可以重做` } : { c: "g", text: `完成 ${p.made}/${p.slots}` };
  const problems = detail?.plan?.problems.length ?? 0;
  return problems ? { c: "y", text: `整理好了，有 ${problems} 处要你看一眼` } : { c: "b", text: "AI 写好了每张图的内容，等你确认" };
};

export function ListingImagesClient() {
  const [config, setConfig] = useState<{ planCredits: number; imageCredits: number; multiCredits: number; exempt: boolean } | null>(null);
  const [editing, setEditing] = useState<{ project: string; slot: string } | null>(null);
  const [projects, setProjects] = useState<Summary[]>([]);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [uploads, setUploads] = useState<Record<string, { done: number; total: number; failed: number }>>({});
  const [settings, setSettings] = useState<{ layout: string; counts: ListingCounts }>({ layout: LISTING_LAYOUTS[0].id, counts: DEFAULT_COUNTS });
  const [pending, setPending] = useState<Group[] | null>(null);
  const [over, setOver] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, ms = 3200) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), ms); }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- localStorage and the server list exist only after mount. */
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); if (saved?.layout && saved?.counts) setSettings(saved); } catch { /* first visit */ }
    api<{ planCredits: number; imageCredits: number; multiCredits: number; exempt: boolean }>("config").then(setConfig).catch(error => say(error.message));
  }, [say]);
  const saveSettings = (next: typeof settings) => { setSettings(next); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* optional */ } };

  const refresh = useCallback(async () => {
    const list = await api<Summary[]>("projects");
    setProjects(list);
    // Products waiting for the user need their plan to show problems in the row.
    const needed = list.filter(p => ["review", "confirmed", "generating", "done"].includes(p.status));
    const loaded = await Promise.all(needed.map(p => api<Detail>("projects/" + p.id).catch(() => null)));
    setDetails(old => ({ ...old, ...Object.fromEntries(loaded.filter((d): d is Detail => !!d).map(d => [d.id, d])) }));
  }, []);
  useEffect(() => { refresh().catch(error => say(error.message)); }, [refresh, say]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const busy = projects.some(p => p.status === "planning" || p.status === "generating") || Object.keys(uploads).length > 0;
  useEffect(() => { if (!busy) return; const t = setInterval(() => void refresh().catch(() => {}), 3000); return () => clearInterval(t); }, [busy, refresh]);

  const startPlan = async (id: string) => {
    try { await post("projects/" + id + "/plan"); await refresh(); } catch (error) { say((error as Error).message); await refresh(); }
  };
  const startGroups = async (groups: Group[]) => {
    if (!groups.length) return say("没有找到图片（只支持 JPG、PNG、WebP）");
    for (const group of groups) {
      const id = crypto.randomUUID();
      try { await post("projects", { id, name: group.name.slice(0, 120), layout: group.layout ?? settings.layout, counts: group.counts ?? settings.counts }); }
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
      if (failed) say(`「${group.name}」有 ${failed} 张没传上：${reasons}。其余 ${group.files.length - failed} 张照常分析`, 12000);
      await startPlan(id);
    }
  };
  // Dropped folders first get a layout each; uploading starts from the dialog.
  const choose = (groups: Group[]) => { if (!groups.length) say("没有找到图片（只支持 JPG、PNG、WebP）"); else setPending(groups); };
  const onDrop = async (event: React.DragEvent) => { event.preventDefault(); setOver(false); choose(await groupsFromDrop(event.dataTransfer.items)); };
  const pick = useRef<HTMLInputElement>(null);

  const generate = async (id: string) => {
    try { await post(`projects/${id}/generate`); setOpen(o => ({ ...o, [id]: true })); await refresh(); } catch (error) { say((error as Error).message); }
  };
  const redo = async (id: string, slot: string, label: string) => {
    const note = window.prompt(`重做「${label}」。有补充要求可以写在这里（可不填），比如：模特换成女生、背景更亮`, "");
    if (note === null) return;
    try {
      const r = await post<{ images: number }>(`projects/${id}/redo`, { slot, note });
      say(r.images > 1 ? `已重新排队 ${r.images} 张：这张和因为它没做出来的图` : "已重新排队");
      await refresh();
    } catch (error) { say((error as Error).message); }
  };
  const toggle = async (id: string) => {
    setOpen(o => ({ ...o, [id]: !o[id] }));
    if (!details[id]) { const d = await api<Detail>("projects/" + id).catch(() => null); if (d) setDetails(old => ({ ...old, [id]: d })); }
  };
  const remove = async (p: Summary) => {
    if (!window.confirm(`删除「${p.name}」？上传的图片和分析结果都会删掉。`)) return;
    try { await api("projects/" + p.id, { method: "DELETE" }); await refresh(); } catch (error) { say((error as Error).message); }
  };

  const editDetail = editing ? details[editing.project] : undefined, editSlot = editDetail?.slots.find(x => x.slot === editing?.slot);

  return (
    <>
      <AppHeader />
      <main className="listing-page">

        <button type="button" className={"lp-drop" + (over ? " over" : "")}
          onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} onClick={() => pick.current?.click()}>
          <b>拖入商品文件夹，放进来先选版式</b>
          可以一次拖多个 · 每个文件夹一个款 · 每款可以用不同的版式 · 里面的图随便放，AI 会自己分类
          {config && !config.exempt && <> · 每款分析 {config.planCredits} 积分</>}
        </button>
        <input ref={pick} type="file" multiple hidden {...{ webkitdirectory: "" }} accept="image/*"
          onChange={e => { const g = groupsFromInput(e.target.files!); e.target.value = ""; choose(g); }} />

        <div className="lp-list">
          {!projects.length && <div className="lp-card lp-empty">还没有商品。把一个商品的主图、SKU 图、详情图放进同一个文件夹，拖到上面。</div>}
          {projects.map(p => {
            const d = details[p.id], s = statusOf(p, uploads[p.id], d), roles = d?.plan ? { ...Object.fromEntries(d.plan.plan.assets.map(a => [a.id, a.role])), ...(d.review?.roles ?? {}) } : {};
            return (
              <div key={p.id} className={"lp-card lp-prod" + (open[p.id] ? " open" : "") + (s.c === "r" || s.c === "y" ? " att" : "")}>
                <div className="lp-ph" onClick={() => void toggle(p.id)}>
                  <span className="chev">▶</span><span className={"lp-dot " + s.c} />
                  {p.cover ? <img className="th" src={p.cover} alt="" /> : <div className="th">{p.name.slice(0, 1)}</div>}
                  <div className="nm" title={p.name}>{p.name}</div>
                  <div className="tp"><b>{LISTING_LAYOUTS.find(l => l.id === p.layout)?.name ?? p.layout}</b>{countsText(p.counts)}</div>
                  <div className={"ss " + s.c}>{s.text}</div>
                  <div className="acts" onClick={e => e.stopPropagation()}>
                    {p.status === "review" && <button type="button" className="lp-btn sm primary" onClick={() => setReviewing(p.id)}>确认内容</button>}
                    {(p.status === "failed" || (p.status === "uploading" && !uploads[p.id] && p.images > 0)) && <button type="button" className="lp-btn sm primary" onClick={() => void startPlan(p.id)}>{p.status === "failed" ? "重新分析" : "开始分析"}</button>}
                    {p.status === "confirmed" && <button type="button" className="lp-btn sm primary" onClick={() => void generate(p.id)}>开始出图{d?.estimate && !config?.exempt ? `（约 ${d.estimate.credits} 积分）` : ""}</button>}
                    {p.made > 0 && <a className="lp-btn sm" href={`/api/listing/projects/${p.id}/download`}>下载</a>}
                    {["confirmed", "generating", "done"].includes(p.status) && <button type="button" className="lp-btn sm ghost" onClick={() => setReviewing(p.id)}>素材和卖点</button>}
                    {!["planning", "generating"].includes(p.status) && !uploads[p.id] && <button type="button" className="lp-btn sm ghost" onClick={() => void remove(p)}>删除</button>}
                  </div>
                </div>
                {open[p.id] && (
                  <div className="lp-pb">
                    {!d ? <span className="lp-muted">正在读取…</span> : (<>
                      {d.slots.length > 0 && <Results detail={d} onEdit={s => setEditing({ project: p.id, slot: s.slot })} onRedo={(slot, label) => void redo(p.id, slot, label)} />}
                      {d.slots.length > 0 && <div className="lp-lane-label">原始素材 {d.images.length} 张
                        <span className="lp-keep">{p.sources_cleared_at ? `已在 ${dayOf(p.sources_cleared_at)} 清理（最后一次出图 30 天后），生成的图不受影响`
                          : p.status === "done" ? `会在 ${dayOf(new Date(Date.parse(p.updated_at) + 30 * 86400_000).toISOString())} 自动清理（最后一次出图 30 天后），生成的图不受影响` : ""}</span></div>}
                      <div className="lp-tiles">{d.images.map(img => (
                        <a key={img.id} className="lp-tile" href={img.url} target="_blank" rel="noreferrer" title={img.path}>
                          <img src={img.url} alt="" loading="lazy" />
                          {roles[img.label] && <span className={"role" + (roles[img.label] === "不用" ? " unused" : "")}>{roles[img.label]}</span>}
                          <small>{img.path}</small>
                        </a>))}
                      </div></>)}
                  </div>)}
              </div>
            );
          })}
        </div>
      </main>
      {reviewing && details[reviewing]?.plan && (
        <ReviewDialog detail={details[reviewing]} readOnly={details[reviewing].status !== "review"} exempt={!!config?.exempt} onClose={() => setReviewing(null)}
          onDone={async message => { setReviewing(null); say(message); await refresh(); }} onError={say} />
      )}
      {pending && <UploadDialog groups={pending} defaults={settings} planCredits={config?.exempt ? 0 : config?.planCredits ?? 0}
        onCancel={() => setPending(null)} onStart={groups => { setPending(null); saveSettings({ layout: groups.at(-1)!.layout!, counts: groups.at(-1)!.counts! }); void startGroups(groups); }} />}
      {editDetail && editSlot && <EditDialog key={editSlot.slot} detail={editDetail} slot={editSlot} prices={{ image: config?.imageCredits ?? 0, multi: config?.multiCredits ?? 0 }} exempt={!!config?.exempt || !config}
        onClose={() => setEditing(null)} onDone={async message => { setEditing(null); say(message); await refresh(); }} onError={say} />}
      {toast && <div className="lp-toast" role="status">{toast}</div>}
    </>
  );
}

const countsText = (c: ListingCounts) => `1:1×${c.square} · 3:4×${c.portrait} · 海报×${c.poster}`;
const COUNT_KEYS = [["square", "1:1", 5], ["portrait", "3:4", 5], ["poster", "海报", 1]] as const;

/** Pick one layout from the cards; the samples show the style only. */
function LayoutPicker({ title, current, onPick, onClose }: { title: string; current: string; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="lp-modal top" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="选一个版式">
        <div className="lp-box-head"><div><h3>{title}</h3><p className="lp-sub">样图是用别的衣服出的，只看风格和排法。</p></div><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <div className="lp-layouts">{LISTING_LAYOUTS.map(l => (
            <button type="button" key={l.id} className={"lp-layout" + (l.id === current ? " on" : "")} onClick={() => onPick(l.id)}>
              <span className="ok">✓</span>
              <div className="pics">{l.samples.map(src => <img key={src} src={src} alt="" />)}</div>
              <b>{l.name}</b><p>{l.description}</p>
            </button>))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** After a drop: each product gets its own layout and image counts before anything is uploaded or charged. */
function UploadDialog({ groups, defaults, planCredits, onCancel, onStart }: { groups: Group[]; defaults: { layout: string; counts: ListingCounts }; planCredits: number; onCancel: () => void; onStart: (groups: Group[]) => void }) {
  const [rows, setRows] = useState(groups.map(g => ({ ...g, layout: defaults.layout, counts: { ...defaults.counts } })));
  const [all, setAll] = useState(defaults.layout);
  const [picking, setPicking] = useState<number | "all" | null>(null);
  const layoutOf = (id: string) => LISTING_LAYOUTS.find(l => l.id === id) ?? LISTING_LAYOUTS[0];
  const pickButton = (id: string, onClick: () => void, wide = true) => {
    const l = layoutOf(id);
    return <button type="button" className="lp-pick" style={wide ? undefined : { width: "auto", minWidth: 220 }} onClick={onClick}>
      <span className="ims">{l.samples.slice(0, 2).map(src => <img key={src} src={src} alt="" />)}</span><span className="nm">{l.name}</span><i>换 ▾</i></button>;
  };
  const step = (i: number, key: keyof ListingCounts, max: number, d: number) => setRows(r => r.map((row, k) => k === i ? { ...row, counts: { ...row.counts, [key]: Math.max(0, Math.min(max, row.counts[key] + d)) } } : row));
  const empty = rows.some(r => r.counts.square + r.counts.portrait + r.counts.poster === 0);
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="选版式">
        <div className="lp-box-head"><div><h3>这次拖进来 {rows.length} 款，各用什么版式？</h3><p className="lp-sub">每款可以用不同的版式和张数，点版式可以换。</p></div><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onCancel}>取消</button></div>
        <div className="lp-box-body">
          {rows.length > 1 && <div className="lp-all">全部用：{pickButton(all, () => setPicking("all"), false)}<button type="button" className="lp-btn sm" onClick={() => setRows(r => r.map(row => ({ ...row, layout: all })))}>应用到全部</button></div>}
          <div className="lp-rows">{rows.map((row, i) => (
            <div key={row.name + i} className="lp-uprow">
              <div className="nm"><b>{row.name}</b><small>{row.files.length} 张图</small></div>
              {pickButton(row.layout, () => setPicking(i))}
              <div className="lp-mini">{COUNT_KEYS.map(([key, label, max]) => (
                <span key={key}>{label}<span className="lp-stepper sm"><button type="button" aria-label={`${label}减少`} onClick={() => step(i, key, max, -1)}>−</button><b>{row.counts[key]}</b><button type="button" aria-label={`${label}增加`} onClick={() => step(i, key, max, 1)}>+</button></span></span>))}
              </div>
            </div>))}
          </div>
        </div>
        <div className="lp-box-foot">
          <div className="grow">{empty ? <span className="lp-bad">每款至少出 1 张主图或海报</span> : planCredits ? <>分析每款 {planCredits} 积分，这次共 <b>{planCredits * rows.length}</b> 积分；出图费用在你确认内容后再扣</> : "确认内容后才开始出图"}</div>
          <button type="button" className="lp-btn" onClick={onCancel}>取消</button>
          <button type="button" className="lp-btn primary" disabled={empty} onClick={() => onStart(rows)}>开始上传并分析</button>
        </div>
      </div>
      {picking !== null && <LayoutPicker title={picking === "all" ? "全部用哪个版式" : `给「${rows[picking].name}」选版式`} current={picking === "all" ? all : rows[picking].layout}
        onClose={() => setPicking(null)} onPick={id => { if (picking === "all") setAll(id); else setRows(r => r.map((row, k) => k === picking ? { ...row, layout: id } : row)); setPicking(null); }} />}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { square: "1:1 主图", portrait: "3:4 主图", poster: "2:3 海报", sku: "SKU 图", product: "白底产品图" };
const SHAPE: Record<string, string> = { square: "1 / 1", portrait: "3 / 4", poster: "2 / 3", sku: "1 / 1", product: "1 / 1" };
const MAIN = /^(square|portrait|poster):/;
const dayOf = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const numOf = (slot: string) => slot.startsWith("poster") ? "海报" : `第 ${slot.split(":")[1]} 张`;

/** One main image's content as the user edits it; labels follow the page wording (小字 = subtitle, 标签 = bullets). */
type Draft = { title: string; subtitle: string; tags: string; scene: string };
const toDraft = (w: Partial<Words> | null | undefined): Draft => ({ title: w?.title ?? "", subtitle: w?.subtitle ?? "", tags: (w?.bullets ?? []).join("、"), scene: w?.scene ?? "" });
const toWords = (d: Draft): Words => ({ title: d.title.trim(), subtitle: d.subtitle.trim(), bullets: d.tags.split(/[、,，;；]/).map(t => t.trim()).filter(Boolean).slice(0, 3), scene: d.scene.trim() });
const sameWords = (a: Draft, b: Draft) => JSON.stringify(toWords(a)) === JSON.stringify(toWords(b));
const FIELDS: [keyof Draft, string, number, string][] = [
  ["title", "大标题", 20, "必填"], ["subtitle", "小字", 30, "可空"], ["tags", "标签", 52, "图上的小标签，用顿号隔开，最多 3 个"], ["scene", "画面", 400, "画面里拍什么、怎么演示卖点"],
];
function DraftFields({ draft, base, onChange, note }: { draft: Draft; base: Draft; onChange: (patch: Partial<Draft>) => void; note?: { value: string; set: (v: string) => void } }) {
  return (<>
    {FIELDS.map(([key, label, max, hint]) => {
      const edited = draft[key].trim() !== base[key].trim() ? "edited" : "";
      return (
        <label key={key} className="lp-field"><span>{label}</span>
          {key === "scene"
            ? <textarea className={edited} maxLength={max} placeholder={hint} value={draft[key]} onChange={e => onChange({ [key]: e.target.value })} />
            : <input className={edited} maxLength={max} placeholder={hint} value={draft[key]} onChange={e => onChange({ [key]: e.target.value })} />}
        </label>);
    })}
    {note && <label className="lp-field"><span>其他要求</span><input maxLength={200} placeholder="可不填，比如：模特换成女生、背景更亮" value={note.value} onChange={e => note.set(e.target.value)} /></label>}
  </>);
}

/** Generated images grouped by kind; a failed one says why under the image. */
function Results({ detail, onEdit, onRedo }: { detail: Detail; onEdit: (slot: SlotState) => void; onRedo: (slot: string, label: string) => void }) {
  const colors = new Map((detail.plan?.plan.product.colors ?? []).map(c => [c.sku, detail.review?.colors.find(r => r.sku === c.sku)?.name ?? c.name]));
  const labelOf = (s: SlotState) => {
    const [kind, key] = s.slot.split(":");
    if (kind === "sku" || kind === "product") return colors.get(key) ?? key;
    return `${numOf(s.slot)} · ${s.words?.title || s.input.slot?.role || ""}`;
  };
  const order = (slot: string) => slot.replace(/\d+$/, n => n.padStart(2, "0"));
  return (<>{(["square", "portrait", "poster", "sku", "product"] as const).map(kind => {
    const items = detail.slots.filter(s => s.slot.startsWith(kind + ":")).sort((a, b) => order(a.slot).localeCompare(order(b.slot)));
    if (!items.length) return null;
    return (
      <div className="lp-lane" key={kind}>
        <div className="lp-lane-label">{KIND_LABEL[kind]}</div>
        <div className="lp-tiles">{items.map(s => {
          const label = labelOf(s), busy = s.status === "queued" || s.status === "running", bad = !s.image && !busy;
          const version = s.history.findIndex(v => v.id === s.image) + 1;
          return (
            <div key={s.slot} className={"lp-out" + (bad ? " bad" : "")}>
              <div className="lp-out-img" style={{ aspectRatio: SHAPE[kind] }}>
                {s.image && <a href={`/api/listing/assets/${s.image}`} target="_blank" rel="noreferrer"><img src={`/api/listing/assets/${s.image}`} alt={label} loading="lazy" /></a>}
                {s.versions > 1 && version > 0 && <span className="lp-out-ver">第 {version} 版</span>}
                {busy && <span className="lp-out-wait">{s.status === "running" ? "出图中…" : "排队中"}</span>}
                {bad && <span className="lp-out-wait">没做出来</span>}
              </div>
              <b title={label}>{label}</b>
              {bad && s.error && <small className="lp-out-why">{s.error}</small>}
              {!busy && detail.status !== "generating" && (MAIN.test(s.slot) && s.history.length
                ? <button type="button" className="lp-btn sm" onClick={() => onEdit(s)}>改这张</button>
                : <button type="button" className="lp-btn sm" onClick={() => onRedo(s.slot, label)}>重做</button>)}
            </div>);
        })}</div>
      </div>);
  })}</>);
}

/**
 * Change one finished main image. What the user changed decides how it is remade: only the words
 * keep the picture (the image being looked at is the reference); a new picture or an extra
 * request redraws it. Earlier versions stay and can be chosen again.
 */
function EditDialog({ detail, slot, prices, exempt, onClose, onDone, onError }: { detail: Detail; slot: SlotState; prices: { image: number; multi: number }; exempt: boolean; onClose: () => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const kind = slot.slot.split(":")[0];
  const [viewing, setViewing] = useState(slot.image ?? slot.history.at(-1)?.id ?? "");
  // The form shows the words of the version being looked at; that is what "只改字" edits.
  const base = toDraft(slot.history.find(v => v.id === viewing)?.words ?? slot.words);
  const [draft, setDraft] = useState<Draft>(base);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const textChanged = (["title", "subtitle", "tags"] as const).some(k => toWords(draft)[k === "tags" ? "bullets" : k].toString() !== toWords(base)[k === "tags" ? "bullets" : k].toString());
  const pictureChanged = draft.scene.trim() !== base.scene.trim() || note.trim() !== "";
  const multi = slot.input.kind === "main" && (slot.input.skus?.length ?? 0) > 1;
  const cost = (n: number) => exempt ? "" : ` · ${n} 积分`;
  const at = slot.history.findIndex(v => v.id === viewing) + 1, current = slot.history.findIndex(v => v.id === slot.image) + 1;
  const submit = async (mode: "redraw" | "text") => {
    setSaving(true);
    try {
      await post(`projects/${detail.id}/redo`, { slot: slot.slot, mode, words: toWords(draft), note: mode === "redraw" ? note : "", base: viewing });
      await onDone(mode === "text" ? `${numOf(slot.slot)}开始改字，约 1 分钟` : `${numOf(slot.slot)}开始重画，约 1 分钟`);
    } catch (error) { onError((error as Error).message); } finally { setSaving(false); }
  };
  const choose = async () => {
    try { await post(`projects/${detail.id}/current`, { slot: slot.slot, asset: viewing }); await onDone(`已改用第 ${at} 版，下载也用这一版`); }
    catch (error) { onError((error as Error).message); }
  };
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="改这一张">
        <div className="lp-box-head"><div><h3>改这一张 · {KIND_LABEL[kind]} {numOf(slot.slot)}{slot.input.slot?.role ? ` · ${slot.input.slot.role}` : ""}</h3><p className="lp-sub">只重出这一张，其他图不动；旧的那张会留着。</p></div><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          <div className="lp-edit">
            <div className="lp-edit-pic">
              {viewing && <img src={`/api/listing/assets/${viewing}`} alt="" style={{ aspectRatio: SHAPE[kind] }} />}
              {slot.history.length > 1 && (
                <div className="lp-vers">以前的版本：{slot.history.map((v, i) => (
                  <button type="button" key={v.id} className={v.id === viewing ? "sel" : ""} title={`第 ${i + 1} 版`} onClick={() => { setViewing(v.id); setDraft(toDraft(v.words ?? slot.words)); setNote(""); }}>
                    <img src={`/api/listing/assets/${v.id}`} alt="" style={{ aspectRatio: SHAPE[kind] }} /></button>))}
                  {viewing === slot.image ? <span>正在用第 {current} 版</span> : <button type="button" className="lp-btn sm" onClick={() => void choose()}>改用第 {at} 版</button>}
                </div>)}
            </div>
            <div className="lp-form">
              <DraftFields draft={draft} base={base} onChange={patch => setDraft(d => ({ ...d, ...patch }))} note={{ value: note, set: setNote }} />
              <div className={"lp-say" + (pictureChanged ? " y" : "")}>{pictureChanged ? "改了画面：整张重新生成，人物和背景会变，衣服不变。"
                : textChanged ? `只改了字：保留第 ${at} 版的画面，只把字换掉。想换个新画面，就点「整张重画」。`
                : "改一下上面的字或画面再提交；什么都不改，也可以直接整张重画一次。"}</div>
            </div>
          </div>
        </div>
        <div className="lp-box-foot">
          <div className="grow" />
          <button type="button" className={"lp-btn" + (textChanged && !pictureChanged ? "" : " primary")} disabled={saving || !draft.title.trim()} onClick={() => void submit("redraw")}>整张重画{cost(multi ? prices.multi : prices.image)}</button>
          {textChanged && !pictureChanged && <button type="button" className="lp-btn primary" disabled={saving || !draft.title.trim()} onClick={() => void submit("text")}>只改字{cost(prices.image)}</button>}
        </div>
      </div>
    </div>
  );
}

function ReviewDialog({ detail, readOnly, exempt, onClose, onDone, onError }: { detail: Detail; readOnly: boolean; exempt: boolean; onClose: () => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const plan = detail.plan!.plan, byLabel = new Map(detail.images.map(i => [i.label, i]));
  const [roles, setRoles] = useState<Record<string, AssetRole>>(detail.review?.roles ?? {});
  const [colors, setColors] = useState<Record<string, string>>(Object.fromEntries((detail.review?.colors ?? plan.product.colors.map(c => ({ sku: c.sku, name: c.name }))).map(c => [c.sku, c.name])));
  const groups = ([["square", "1:1 主图"], ["portrait", "3:4 主图"], ["poster", "2:3 海报"]] as const)
    .map(([key, label]) => ({ key, label, slots: plan.main[key].slice(0, detail.counts[key]).map((s, i) => ({ ...s, key: `${key}:${i + 1}`, ai: toDraft({ ...s, bullets: s.bullets.slice(0, 3) }) })) }))
    .filter(g => g.slots.length);
  const slots = groups.flatMap(g => g.slots);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(Object.fromEntries(slots.map(s => [s.key, detail.review?.slots?.[s.key] ? toDraft({ ...detail.review.slots[s.key], scene: detail.review.slots[s.key].scene ?? s.scene }) : s.ai])));
  const [opened, setOpened] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const roleOf = (id: string) => roles[id] ?? plan.assets.find(a => a.id === id)?.role ?? "不用";
  const missing = plan.product.colors.filter(c => roleOf(c.sku) !== "SKU");
  const problems = detail.plan!.problems;
  const changed = slots.filter(s => !sameWords(drafts[s.key], s.ai)).length, empty = slots.some(s => !drafts[s.key].title.trim());
  const submit = async () => {
    setSaving(true);
    try {
      await post(`projects/${detail.id}/review`, { roles, colors: plan.product.colors.map(c => ({ sku: c.sku, name: colors[c.sku]?.trim() || c.name })), slots: Object.fromEntries(slots.map(s => [s.key, toWords(drafts[s.key])])) });
      await post(`projects/${detail.id}/confirm`);
      await post(`projects/${detail.id}/generate`);
      await onDone("已开始出图，每张约 1 分钟，做好的会陆续出现");
    } catch (error) { onError((error as Error).message); } finally { setSaving(false); }
  };
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="确认每张图的内容">
        <div className="lp-box-head"><div><h3>{readOnly ? "每张图的内容" : "确认每张图的内容"} · {detail.name}</h3><p className="lp-sub">{readOnly ? "出图时用的内容。要改哪张，关掉这里，点那张图下面的「改这张」。" : "AI 已经写好了，不满意的点「改」。字会原样印在图上。"}</p></div><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          {missing.length > 0 && <div className="lp-alert y">颜色「{missing.map(c => colors[c.sku] || c.name).join("、")}」对应的图被改成了非 SKU。出图要靠这张图定颜色，请在下面「颜色和素材分类」里改回 SKU。</div>}
          {groups.map(g => (
            <div key={g.key} className="lp-group"><h4>{g.label}</h4>
              <div className="lp-rows">{g.slots.map(s => {
                const d = drafts[s.key], isOpen = opened === s.key && !readOnly, edited = !sameWords(d, s.ai), w = toWords(d);
                const small = [w.subtitle, w.bullets.join("、")].filter(Boolean).join(" · ");
                return (
                  <div key={s.key} className={"lp-r" + (edited ? " changed" : "") + (isOpen ? " open" : "")}>
                    <div className="n"><b>{numOf(s.key)}</b>{s.role}</div>
                    <div>{isOpen
                      ? <div className="lp-form"><DraftFields draft={d} base={s.ai} onChange={patch => setDrafts(v => ({ ...v, [s.key]: { ...v[s.key], ...patch } }))} /></div>
                      : <><div className="t">{w.title || <span className="lp-bad">（没写大标题）</span>}</div>{small && <div className="s">{small}</div>}{w.scene && <div className="s">画面：{w.scene}</div>}</>}</div>
                    <div className="acts">{readOnly ? null : isOpen
                      ? <>{edited && <button type="button" className="lp-btn link" onClick={() => setDrafts(v => ({ ...v, [s.key]: s.ai }))}>恢复 AI 原稿</button>}<button type="button" className="lp-btn sm primary" onClick={() => setOpened(null)}>好了</button></>
                      : <>{edited && <span className="mark">已改</span>}<button type="button" className="lp-btn sm" onClick={() => setOpened(s.key)}>改</button></>}</div>
                  </div>);
              })}</div>
            </div>))}
          {slots.length === 0 && <span className="lp-muted">这一款没有选主图</span>}
          <details className="lp-more" open={missing.length > 0 || problems.length > 0}>
            <summary>颜色和素材分类{problems.length ? `（AI 有 ${problems.length} 处对不上，请看一眼）` : "（AI 已分好，一般不用动）"}</summary>
            {problems.length > 0 && <div className="lp-alert y">AI 的结果有 {problems.length} 处对不上：{problems.join("；")}。分类不对的请在下面改；其余的出图时会按规则处理。</div>}
            <div className="lp-sec">
              <h4>颜色<span>每个颜色出一张 SKU 图，名字原样写在图上</span></h4>
              <div className="lp-colors">{plan.product.colors.map(c => (
                <label key={c.sku} className="lp-color">{byLabel.get(c.sku) && <img src={byLabel.get(c.sku)!.url} alt="" />}
                  <input value={colors[c.sku] ?? c.name} maxLength={20} disabled={readOnly} onChange={e => setColors(v => ({ ...v, [c.sku]: e.target.value }))} /></label>))}
              </div>
            </div>
            <div className="lp-sec">
              <h4>素材分类<span>{detail.images.length} 张 · AI 看图分的，不对就改；「不用」的图不会参考</span></h4>
              <div className="lp-sort">{plan.assets.map(a => {
                const img = byLabel.get(a.id); if (!img) return null;
                return (
                  <figure key={a.id} className={roles[a.id] && roles[a.id] !== a.role ? "changed" : ""}>
                    <img src={img.url} alt="" loading="lazy" />
                    <select value={roleOf(a.id)} disabled={readOnly} onChange={e => setRoles(r => ({ ...r, [a.id]: e.target.value as AssetRole }))}>
                      {ASSET_ROLES.map(role => <option key={role}>{role}</option>)}
                    </select>
                    <figcaption>{a.reason || img.path}</figcaption>
                  </figure>);
              })}</div>
            </div>
          </details>
        </div>
        <div className="lp-box-foot">
          <div className="grow">{readOnly ? "已经出图了。" : <>共出 <b>{detail.estimate?.images ?? "—"}</b> 张（含白底图和 SKU 图）{!exempt && detail.estimate && <>，约 <b>{detail.estimate.credits}</b> 积分，先冻结，没做出来的退回</>}{changed > 0 && <> · 你改了 {changed} 张</>}{empty && <span className="lp-bad"> · 有图没写大标题</span>}</>}</div>
          <button type="button" className="lp-btn" onClick={onClose}>{readOnly ? "关闭" : "先不出图"}</button>
          {!readOnly && <button type="button" className="lp-btn primary" disabled={saving || missing.length > 0 || empty} onClick={() => void submit()}>{saving ? "正在开始…" : "开始出图"}</button>}
        </div>
      </div>
    </div>
  );
}
