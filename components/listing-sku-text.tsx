"use client";
/* eslint-disable @next/next/no-img-element -- the preview is a data URL made by the server */
/**
 * 「改 SKU 图文字」 (11-01): every word on the product's SKU images written by hand, for the whole
 * product (all colours re-carded together, the colour row following each image's colour) or for one
 * image. Left: the real card as it will print (the server draws it with the image's picture kept);
 * right: the words, starting from what the image says now. Saving re-cards the images, free.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/listing/client-api";
import { SKU_TEXT_ICONS, SKU_TEXT_MAX, SKU_TEXT_ROWS, skuTextProblems, type SkuEdits, type SkuTextEdit, type SkuTextRow } from "@/lib/listing/sku-text";

type Item = { key: string; name: string; image: string; own: SkuTextEdit; liner: boolean };
type State = { items: Item[]; edits: SkuEdits };
export type SkuTextTarget = { mode: "all" } | { mode: "one"; key: string };

const blankRow = (): SkuTextRow => ({ label: "", value: "", sub: "" });
/** The form's rows and icons always three, empty where the image has fewer. */
function padded(e: SkuTextEdit): SkuTextEdit {
  return { ...e, rows: Array.from({ length: SKU_TEXT_ROWS }, (_, i) => e.rows[i] ?? blankRow()), feature: { ...e.feature, icons: Array.from({ length: SKU_TEXT_ICONS }, (_, i) => e.feature.icons[i] ?? "") } };
}
/** One image's words as plain text: its colour row written out, nothing following. */
const plain = (e: SkuTextEdit, own: SkuTextEdit): SkuTextEdit => {
  const color = own.rows.find(r => r.color);
  return { ...e, rows: e.rows.map(r => r.color ? { label: r.label, value: color?.value ?? "", sub: color?.sub ?? "" } : r) };
};

export function SkuTextDialog({ projectId, name, target, onSaved, onError, onClose }: {
  projectId: string; name: string; target: SkuTextTarget;
  onSaved: (message: string) => void; onError: (message: string) => void; onClose: () => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [mode, setMode] = useState(target.mode);
  const [key, setKey] = useState(target.mode === "one" ? target.key : "");
  const [form, setForm] = useState<SkuTextEdit | null>(null);
  const [preview, setPreview] = useState<{ image: string; busy: boolean; error?: string }>({ image: "", busy: false });
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);

  /** The words the form starts from in a mode: the saved edit, else what the image prints now. */
  const start = (s: State, m: "all" | "one", k: string): SkuTextEdit => {
    const item = s.items.find(i => i.key === k) ?? s.items[0];
    if (m === "all") return padded(s.edits.all ?? s.items[0].own);
    return padded(plain(s.edits.one?.[item.key] ?? s.edits.all ?? item.own, item.own));
  };
  useEffect(() => {
    let live = true;
    api<State>(`projects/${projectId}/sku-text`).then(s => {
      if (!live) return;
      if (!s.items.length) { onError("这一款没有按模板拼的 SKU 图"); onClose(); return; }
      const k = target.mode === "one" && s.items.some(i => i.key === target.key) ? target.key : s.items[0].key;
      setState(s); setKey(k); setForm(start(s, target.mode, k));
    }).catch(e => { onError((e as Error).message); onClose(); });
    return () => { live = false; };
    // Loaded once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const problems = useMemo(() => form ? skuTextProblems(form) : [], [form]);
  const bad = new Set(problems.map(p => p.where));
  // The preview: the image the form shows (in whole-product mode, the colour picked under it), drawn a moment after the last key.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined), asked = useRef(0);
  useEffect(() => {
    if (!form || !key || problems.length) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const n = ++asked.current;
      setPreview(p => ({ ...p, busy: true }));
      post<{ image: string }>(`projects/${projectId}/sku-text/preview`, { item: key, edit: form })
        .then(r => { if (n === asked.current) setPreview({ image: r.image, busy: false }); })
        .catch(e => { if (n === asked.current) setPreview(p => ({ ...p, busy: false, error: (e as Error).message })); });
    }, 600);
    return () => clearTimeout(timer.current);
  }, [form, key, problems.length, projectId]);

  if (!state || !form) return <div className="lp-modal"><div className="lp-box lp-skutext"><div className="lp-box-body"><p className="lp-say">正在读 SKU 图上的字…</p></div></div></div>;
  const item = state.items.find(i => i.key === key) ?? state.items[0];
  const ones = Object.keys(state.edits.one ?? {}).filter(k => state.items.some(i => i.key === k));
  const hasLiner = mode === "all" ? state.items.some(i => i.liner) : item.liner;
  const set = (patch: Partial<SkuTextEdit>) => setForm(f => f && { ...f, ...patch });
  const setRow = (i: number, patch: Partial<SkuTextRow>) => set({ rows: form.rows.map((r, k) => k === i ? { ...r, ...patch } : r) });
  const switchTo = (m: "all" | "one", k = key) => { setMode(m); setKey(k); setForm(start(state, m, k)); setOverwrite(false); };
  const field = (where: string, value: string, max: number, onChange: (v: string) => void, placeholder = "", wide = false) => (
    <input className={"lp-in" + (bad.has(where) ? " bad" : "") + (wide ? " wide" : "")} value={value} placeholder={placeholder} aria-label={where}
      title={`最多 ${max} 个字（英文和数字算半个）`} onChange={e => onChange(e.target.value)} />);

  const save = async (edit: SkuTextEdit | null) => {
    setSaving(true);
    try {
      const sent = edit && mode === "one" ? { ...edit, rows: edit.rows.map(r => ({ label: r.label, value: r.value, sub: r.sub })) } : edit;
      const r = await post<{ images: number }>(`projects/${projectId}/sku-text`, { scope: mode === "all" ? "all" : key, edit: sent, ...(mode === "all" && overwrite ? { overwrite: true } : {}) });
      onSaved(r.images ? `SKU 图开始重拼 ${r.images} 张，免费，旧的留在历史里` : "存好了；SKU 图还没出好，出好时按这些字拼");
      onClose();
    } catch (e) { onError((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="lp-modal" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="lp-box lp-skutext" role="dialog" aria-modal="true" aria-label="改 SKU 图文字">
        <div className="lp-box-head"><div><h3>改 SKU 图文字 · {name}</h3>
          <p className="lp-sub">图上的字都是程序排的，改字不重画模特、不花钱，写什么就印什么。</p></div>
          <div className="grow" /><button type="button" className="lp-btn sm ghost" disabled={saving} onClick={onClose}>关闭</button></div>
        <div className="lp-skutext-scope">
          <span className="lp-small">改哪些：</span>
          <label className={"lp-chip" + (mode === "all" ? " on" : "")}><input type="radio" hidden checked={mode === "all"} onChange={() => switchTo("all")} />整款一起改（{state.items.length} 张）</label>
          <label className={"lp-chip" + (mode === "one" ? " on" : "")}><input type="radio" hidden checked={mode === "one"} onChange={() => switchTo("one")} />只改这一张</label>
          {mode === "one" && <select className="lp-in" value={key} onChange={e => switchTo("one", e.target.value)}>{state.items.map(i => <option key={i.key} value={i.key}>{i.name}{state.edits.one?.[i.key] ? " · 单独改过" : ""}</option>)}</select>}
        </div>
        <div className="lp-skutext-body">
          <div className="pv">
            <div className={"img" + (preview.busy ? " busy" : "")}>{preview.image ? <img src={preview.image} alt="预览" /> : <img src={`/api/listing/assets/${item.image}`} alt="现在这张" />}
              {preview.busy && <span>刷新中…</span>}</div>
            {mode === "all" && <label className="lp-small">预览哪个颜色 <select className="lp-in" value={key} onChange={e => setKey(e.target.value)}>{state.items.map(i => <option key={i.key} value={i.key}>{i.name}</option>)}</select></label>}
            <p className="lp-muted lp-small">{problems.length ? "有字太长，改短了才刷新预览" : preview.error ? `预览没出来：${preview.error}` : "这就是印出来的样子：右边模特不变，只换左边的字。"}</p>
          </div>
          <div className="form">
            <h4>角标</h4>
            <div className="line">{field("角标", form.badge, SKU_TEXT_MAX.badge, v => set({ badge: v }), "空着就不放角标")}</div>
            <h4>标题区</h4>
            <div className="line"><span>英文小字</span>{field("英文小字", form.kicker, SKU_TEXT_MAX.kicker, v => set({ kicker: v }), "空着就不放", true)}</div>
            <div className="line"><span>标题</span>{field("标题第 1 行", form.title[0], SKU_TEXT_MAX.title, v => set({ title: [v, form.title[1]] }), "第 1 行")}{field("标题第 2 行", form.title[1], SKU_TEXT_MAX.title, v => set({ title: [form.title[0], v] }), "第 2 行")}</div>
            {hasLiner && <><h4>内胆小图</h4><div className="line"><span>名字</span>{field("内胆小图的名字", form.liner, SKU_TEXT_MAX.liner, v => set({ liner: v }), "空着就不写名字")}</div></>}
            <h4>左边三行 <small>大字空着，这一行就不放</small></h4>
            {form.rows.map((r, i) => (
              <div key={i} className="row3">
                <b>第 {i + 1} 行</b>
                {field(`第 ${i + 1} 行的小字`, r.label, SKU_TEXT_MAX.label, v => setRow(i, { label: v }), "小字，如 货号")}
                {r.color && mode === "all" ? <span className="follow">大字和说明写各自的颜色名</span>
                  : <>{field(`第 ${i + 1} 行的大字`, r.value, SKU_TEXT_MAX.value, v => setRow(i, { value: v }), "大字")}
                    {field(`第 ${i + 1} 行的说明`, r.sub, SKU_TEXT_MAX.sub, v => setRow(i, { sub: v }), "说明（可空）")}</>}
                {mode === "all" && <label className="lp-small"><input type="checkbox" checked={!!r.color} onChange={e => setRow(i, { color: e.target.checked || undefined, ...(e.target.checked && !r.label ? { label: "COLOR/颜色" } : {}) })} /> 跟着各颜色走</label>}
              </div>))}
            <h4>卖点卡片 <small>标题空着就不放卡片；图标跟着字自动换</small></h4>
            <div className="line"><span>标题</span>{field("卖点卡片标题", form.feature.title, SKU_TEXT_MAX.featureTitle, v => set({ feature: { ...form.feature, title: v } }), "卡片标题")}</div>
            <div className="line"><span>小字</span>{field("卖点卡片小字", form.feature.sub, SKU_TEXT_MAX.featureSub, v => set({ feature: { ...form.feature, sub: v } }), "一行小字（可空）", true)}</div>
            <div className="line"><span>图标字</span>{form.feature.icons.map((t, i) => <span key={i}>{field(`图标 ${i + 1} 的字`, t, SKU_TEXT_MAX.icon, v => set({ feature: { ...form.feature, icons: form.feature.icons.map((x, k) => k === i ? v : x) } }), `图标 ${i + 1}`)}</span>)}</div>
          </div>
        </div>
        <div className="lp-box-foot">
          <div className="grow lp-small">
            {problems.length > 0 && <span className="lp-bad">{problems.map(p => `${p.where}太长，最多 ${p.max} 个字`).join("；")}（英文和数字算半个）</span>}
            {!problems.length && mode === "all" && ones.length > 0 && <label><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} /> 有 {ones.length} 张单独改过（{ones.map(k => state.items.find(i => i.key === k)?.name).join("、")}），这次也盖掉它们</label>}
            {!problems.length && mode === "all" && state.edits.all && <button type="button" className="lp-btn link" disabled={saving} onClick={() => void save(null)}>恢复成系统默认的字</button>}
            {!problems.length && mode === "one" && state.edits.one?.[key] && <button type="button" className="lp-btn link" disabled={saving} onClick={() => void save(null)}>恢复成跟整款一样</button>}
          </div>
          <button type="button" className="lp-btn" disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className="lp-btn primary" disabled={saving || problems.length > 0} onClick={() => void save(form)}>
            {saving ? "保存中…" : mode === "all" ? `保存并重拼 ${state.items.length - (overwrite ? 0 : ones.length)} 张` : "保存并重拼这一张"}</button>
        </div>
      </div>
    </div>
  );
}
