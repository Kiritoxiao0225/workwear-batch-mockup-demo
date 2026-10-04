"use client";
/* eslint-disable @next/next/no-img-element -- images come from the authenticated listing API */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "./app-header";
import { ASSET_ROLES, DEFAULT_COUNTS, LISTING_LAYOUTS, type AssetRole, type ListingCounts } from "@/lib/listing/layouts";
import "./listing-images.css";

type Summary = { id: string; name: string; layout: string; counts: ListingCounts; status: "uploading" | "planning" | "review" | "confirmed" | "failed" | "generating" | "done"; error: string | null; images: number; cover: string | null; slots: number; made: number; broken: number };
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
type Words = { title: string; subtitle: string; bullets: string[] };
type Review = { roles: Record<string, AssetRole>; colors: { sku: string; name: string }[]; slots: Record<string, Words> };
type SlotState = { slot: string; status: string; error: string | null; image: string | null; versions: number; input: { kind: string; slot?: { role: string; title: string } } };
type Detail = Summary & { images: { id: string; label: string; name: string; path: string; shape: string; url: string }[]; plan: Plan | null; review: Review | null; estimate: { images: number; credits: number } | null; slots: SlotState[] };
type Group = { name: string; files: { file: File; path: string }[] };

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
  return problems ? { c: "y", text: `整理好了，有 ${problems} 处要你看一眼` } : { c: "b", text: "素材和卖点整理好了，等你确认" };
};

export function ListingImagesClient() {
  const [config, setConfig] = useState<{ planCredits: number; exempt: boolean } | null>(null);
  const [projects, setProjects] = useState<Summary[]>([]);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [uploads, setUploads] = useState<Record<string, { done: number; total: number; failed: number }>>({});
  const [settings, setSettings] = useState<{ layout: string; counts: ListingCounts }>({ layout: LISTING_LAYOUTS[0].id, counts: DEFAULT_COUNTS });
  const [planOpen, setPlanOpen] = useState(true);
  const [over, setOver] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string, ms = 3200) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), ms); }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- localStorage and the server list exist only after mount. */
  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); if (saved?.layout && saved?.counts) { setSettings(saved); setPlanOpen(false); } } catch { /* first visit */ }
    api<{ planCredits: number; exempt: boolean }>("config").then(setConfig).catch(error => say(error.message));
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
      try { await post("projects", { id, name: group.name.slice(0, 120), layout: settings.layout, counts: settings.counts }); }
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
  const onDrop = async (event: React.DragEvent) => { event.preventDefault(); setOver(false); await startGroups(await groupsFromDrop(event.dataTransfer.items)); };
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

  const layout = LISTING_LAYOUTS.find(l => l.id === settings.layout) ?? LISTING_LAYOUTS[0];
  const lane = (key: keyof ListingCounts, label: string, cls: string, max: number) => (
    <div className="lp-count" key={key}>
      <label>{label}</label>
      <div className="lp-boxes">{settings.counts[key] ? Array.from({ length: settings.counts[key] }, (_, i) => <i key={i} className={cls} />) : "不出"}</div>
      <div className="lp-stepper">
        <button type="button" aria-label="减少" onClick={() => saveSettings({ ...settings, counts: { ...settings.counts, [key]: Math.max(0, settings.counts[key] - 1) } })}>−</button>
        <b>{settings.counts[key]} 张</b>
        <button type="button" aria-label="增加" onClick={() => saveSettings({ ...settings, counts: { ...settings.counts, [key]: Math.min(max, settings.counts[key] + 1) } })}>+</button>
      </div>
    </div>
  );
  const noImages = settings.counts.square + settings.counts.portrait + settings.counts.poster === 0;

  return (
    <>
      <AppHeader />
      <main className="listing-page">
        <section className="lp-card lp-plan">
          {planOpen ? (<>
            <div className="lp-plan-head"><h2>出图方案</h2><span>拖进来的款都按这个出；改了只影响之后拖进来的款</span><div style={{ flex: 1 }} /><button type="button" className="lp-btn sm" onClick={() => setPlanOpen(false)}>收起</button></div>
            <div className="lp-plan-body">
              <div>
                <div className="lp-q"><i>1</i>用哪个版式</div>
                <div className="lp-layouts">{LISTING_LAYOUTS.map(l => (
                  <button type="button" key={l.id} className={"lp-layout" + (l.id === settings.layout ? " on" : "")} onClick={() => saveSettings({ ...settings, layout: l.id })}>
                    <span className="ok">✓</span>
                    <div className="pics">{l.samples.map(src => <img key={src} src={src} alt="" />)}</div>
                    <b>{l.name}</b><p>{l.description}</p>
                  </button>))}
                </div>
              </div>
              <div>
                <div className="lp-q"><i>2</i>每款出哪些图</div>
                <div className="lp-counts">
                  {lane("square", "1:1 主图", "sq", 5)}{lane("portrait", "3:4 主图", "pt", 5)}{lane("poster", "2:3 海报", "ps", 1)}
                  <div className="lp-count"><label>SKU 图</label><div className="lp-boxes">每个颜色 1 张，有几个颜色出几张</div><span /></div>
                </div>
              </div>
            </div>
          </>) : (
            <div className="lp-plan-mini">
              <b>出图方案</b><img src={layout.samples[0]} alt="" /><span>{layout.name}</span>
              <span className="lp-muted">每款 1:1×{settings.counts.square} · 3:4×{settings.counts.portrait} · 2:3×{settings.counts.poster} · SKU 每色 1 张</span>
              <div style={{ flex: 1 }} /><button type="button" className="lp-btn sm" onClick={() => setPlanOpen(true)}>改</button>
            </div>
          )}
        </section>

        <button type="button" className={"lp-drop" + (over ? " over" : "")} disabled={noImages}
          onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} onClick={() => pick.current?.click()}>
          <b>{noImages ? "先在上面选至少 1 张主图" : "拖入商品文件夹，放进来就上传并开始分析"}</b>
          可以一次拖多个 · 每个文件夹一个款 · 里面的图随便放，AI 会自己分类
          {config && !config.exempt && <> · 每款分析 {config.planCredits} 积分</>}
        </button>
        <input ref={pick} type="file" multiple hidden {...{ webkitdirectory: "" }} accept="image/*"
          onChange={e => { const g = groupsFromInput(e.target.files!); e.target.value = ""; void startGroups(g); }} />

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
                  <div className="tp">{LISTING_LAYOUTS.find(l => l.id === p.layout)?.name ?? p.layout}</div>
                  <div className={"ss " + s.c}>{s.text}</div>
                  <div className="acts" onClick={e => e.stopPropagation()}>
                    {p.status === "review" && <button type="button" className="lp-btn sm primary" onClick={() => setReviewing(p.id)}>确认素材和卖点</button>}
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
                      {d.slots.length > 0 && <Results detail={d} onRedo={(slot, label) => void redo(p.id, slot, label)} />}
                      {d.slots.length > 0 && <div className="lp-lane-label">原始素材 {d.images.length} 张</div>}
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
      {toast && <div className="lp-toast" role="status">{toast}</div>}
    </>
  );
}

const KIND_LABEL: Record<string, string> = { square: "1:1 主图", portrait: "3:4 主图", poster: "2:3 海报", sku: "SKU 图", product: "白底产品图" };
const SHAPE: Record<string, string> = { square: "1 / 1", portrait: "3 / 4", poster: "2 / 3", sku: "1 / 1", product: "1 / 1" };

/** Generated images grouped by kind; a failed one says why under the image. */
function Results({ detail, onRedo }: { detail: Detail; onRedo: (slot: string, label: string) => void }) {
  const colors = new Map((detail.plan?.plan.product.colors ?? []).map(c => [c.sku, detail.review?.colors.find(r => r.sku === c.sku)?.name ?? c.name]));
  const labelOf = (s: SlotState) => {
    const [kind, key] = s.slot.split(":");
    if (kind === "sku" || kind === "product") return colors.get(key) ?? key;
    return kind === "poster" ? "海报" : `第 ${key} 张 · ${s.input.slot?.role ?? ""}`;
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
          return (
            <div key={s.slot} className={"lp-out" + (bad ? " bad" : "")}>
              <div className="lp-out-img" style={{ aspectRatio: SHAPE[kind] }}>
                {s.image && <a href={`/api/listing/assets/${s.image}`} target="_blank" rel="noreferrer"><img src={`/api/listing/assets/${s.image}`} alt={label} loading="lazy" /></a>}
                {busy && <span className="lp-out-wait">{s.status === "running" ? "出图中…" : "排队中"}</span>}
                {bad && <span className="lp-out-wait">没做出来</span>}
              </div>
              <b title={label}>{label}{s.versions > 1 ? ` · 第 ${s.versions} 版` : ""}</b>
              {bad && s.error && <small className="lp-out-why">{s.error}</small>}
              {!busy && detail.status !== "generating" && <button type="button" className="lp-btn sm" onClick={() => onRedo(s.slot, label)}>重做</button>}
            </div>);
        })}</div>
      </div>);
  })}</>);
}

function ReviewDialog({ detail, readOnly, exempt, onClose, onDone, onError }: { detail: Detail; readOnly: boolean; exempt: boolean; onClose: () => void; onDone: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const plan = detail.plan!.plan, byLabel = new Map(detail.images.map(i => [i.label, i]));
  const [roles, setRoles] = useState<Record<string, AssetRole>>(detail.review?.roles ?? {});
  const [colors, setColors] = useState<Record<string, string>>(Object.fromEntries((detail.review?.colors ?? plan.product.colors.map(c => ({ sku: c.sku, name: c.name }))).map(c => [c.sku, c.name])));
  const slots = ([["square", "1:1"], ["portrait", "3:4"], ["poster", "2:3"]] as const)
    .flatMap(([key, ratio]) => plan.main[key].slice(0, detail.counts[key]).map((s, i) => ({ ...s, key: `${key}:${i + 1}`, ratio })));
  const [words, setWords] = useState<Record<string, Words>>(Object.fromEntries(slots.map(s => [s.key, detail.review?.slots?.[s.key] ?? { title: s.title, subtitle: s.subtitle, bullets: s.bullets.slice(0, 3) }])));
  const [saving, setSaving] = useState(false);
  const roleOf = (id: string) => roles[id] ?? plan.assets.find(a => a.id === id)?.role ?? "不用";
  const missing = plan.product.colors.filter(c => roleOf(c.sku) !== "SKU");
  const edit = (key: string, patch: Partial<Words>) => setWords(w => ({ ...w, [key]: { ...w[key], ...patch } }));
  const submit = async () => {
    setSaving(true);
    try {
      await post(`projects/${detail.id}/review`, { roles, colors: plan.product.colors.map(c => ({ sku: c.sku, name: colors[c.sku]?.trim() || c.name })), slots: words });
      await post(`projects/${detail.id}/confirm`);
      await post(`projects/${detail.id}/generate`);
      await onDone("已开始出图，每张约 1 分钟，做好的会陆续出现");
    } catch (error) { onError((error as Error).message); } finally { setSaving(false); }
  };
  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lp-box" role="dialog" aria-modal="true" aria-label="确认素材和卖点">
        <div className="lp-box-head"><h3>{readOnly ? "素材和卖点" : "确认素材和卖点"} · {detail.name}</h3><div className="grow" /><button type="button" className="lp-btn sm ghost" onClick={onClose}>关闭</button></div>
        <div className="lp-box-body">
          {detail.plan!.problems.length > 0 && <div className="lp-alert y">AI 的结果有 {detail.plan!.problems.length} 处对不上：{detail.plan!.problems.join("；")}。分类不对的请在下面改；其余的出图时会按规则处理。</div>}
          {missing.length > 0 && <div className="lp-alert y">颜色「{missing.map(c => colors[c.sku] || c.name).join("、")}」对应的图被改成了非 SKU。出图要靠这张图定颜色，请改回 SKU。</div>}
          <div className="lp-sec">
            <h4>每张图上写什么<span>字会原样印在图上；没写的地方不会自己加字</span></h4>
            <div className="lp-words">{slots.map(s => (
              <div key={s.key} className="lp-word">
                <em>{s.ratio} 第 {s.key.split(":")[1]} 张<br /><small>{s.role}</small></em>
                <input value={words[s.key].title} maxLength={20} disabled={readOnly} placeholder="主标题" onChange={e => edit(s.key, { title: e.target.value })} />
                <input value={words[s.key].subtitle} maxLength={30} disabled={readOnly} placeholder="副标题（可空）" onChange={e => edit(s.key, { subtitle: e.target.value })} />
                <input value={words[s.key].bullets.join("、")} disabled={readOnly} placeholder="要点，用顿号隔开，最多 3 条（可空）"
                  onChange={e => edit(s.key, { bullets: e.target.value.split(/[、,，]/).map(t => t.trim()).filter(Boolean).slice(0, 3) })} />
              </div>))}
              {slots.length === 0 && <span className="lp-muted">这一款没有选主图</span>}
            </div>
          </div>
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
        </div>
        <div className="lp-box-foot">
          <div className="grow">{readOnly ? "已确认，出图按这一份来。" : <>确认后马上开始出图：共 <b>{detail.estimate?.images ?? "—"}</b> 张（每个颜色一张白底产品图 + 一张 SKU 图，加上主图）{!exempt && detail.estimate && <>，约 <b>{detail.estimate.credits}</b> 积分，先冻结，没做出来的退回</>}。</>}</div>
          <button type="button" className="lp-btn" onClick={onClose}>{readOnly ? "关闭" : "先不确认"}</button>
          {!readOnly && <button type="button" className="lp-btn primary" disabled={saving || missing.length > 0 || slots.some(s => !words[s.key].title.trim())} onClick={() => void submit()}>{saving ? "正在开始…" : "确认并开始出图"}</button>}
        </div>
      </div>
    </div>
  );
}
