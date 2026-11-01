"use client";
/**
 * 店铺设置「SKU 图左边写什么」(11-01; laid out again the same day: the first version, a list of combos
 * with arrows, was 「看不懂，很难用」). One scheme at a time, picked from a dropdown: its three rows are
 * three dropdowns (a field or 「不放」), beside a small picture of the SKU image's left column with sample
 * words, so what it does is seen, not read. 「不指定」 is built in (the rule from before) and a tick says
 * which scheme new products use.
 */
import { useState } from "react";
import {
  SKU_AUTO, SKU_AUTO_SET, SKU_FIELD_MAX, SKU_FIELDS, SKU_SET_NAME_MAX, SKU_SETS_MAX, skuFieldName,
  type SkuField, type SkuFieldSet, type SkuFieldSets,
} from "@/lib/listing/sku-card";

/** Sample words for the picture (8826's). */
const SAMPLE: Record<SkuField, string> = { style: "8826", fabric: "双经双纬T800", fit: "经典百搭款", detail: "YKK拉链", scene: "通勤 户外", color: "藏青" };
const AUTO_SAYS = "系统从货号、面料、版型、工艺、适用场景里，挑这款素材里有的前两个，第 3 行放颜色（和以前一样）。";
const newId = () => "f" + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");

/** The SKU image's left column with sample words: the title, the rows, the card under them. */
export function SkuLeftPreview({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <div className="lp-skuprev" aria-hidden="true">
      <i className="kicker">PREMIUM QUALITY</i><b className="title">品质做工<br />舒适百搭</b>
      <div className="rows">{rows.length ? rows.map((r, i) => <div key={i} className="row"><span className="dot" /><span><small>{r.label}</small><b>{r.value}</b></span></div>)
        : <p className="none">一行都不放</p>}</div>
      <div className="card">卖点卡片</div>
    </div>
  );
}

export function SkuFieldsSection({ value, onSave }: { value: SkuFieldSets; onSave: (next: SkuFieldSets) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(value); }
  const defaultId = draft.sets.some(x => x.id === draft.default) ? draft.default : SKU_AUTO;
  const [pick, setPick] = useState(defaultId);
  const [naming, setNaming] = useState<string | null>(null);
  const all = [SKU_AUTO_SET, ...draft.sets], set = all.find(x => x.id === pick) ?? SKU_AUTO_SET, auto = set.id === SKU_AUTO;
  const save = (next: SkuFieldSets) => { setDraft(next); void onSave(next).then(ok => { if (!ok) setDraft(value); }); };
  const setOne = (patch: Partial<SkuFieldSet>) => save({ ...draft, sets: draft.sets.map(x => x.id === set.id ? { ...x, ...patch } : x) });

  // Three rows, 「不放」 where there is nothing; a field picked in another row moves here (they swap).
  const rows: (SkuField | "")[] = Array.from({ length: SKU_FIELD_MAX }, (_, i) => set.fields[i] ?? "");
  const setRow = (i: number, f: SkuField | "") => {
    const next = [...rows], at = f ? next.indexOf(f) : -1;
    if (at >= 0 && at !== i) next[at] = next[i];
    next[i] = f;
    const fields = next.filter((x): x is SkuField => !!x);
    if (fields.length) setOne({ fields });
  };
  const add = () => {
    let n = draft.sets.length + 1;
    while (draft.sets.some(x => x.name === `方案${n}`)) n++;
    const made = { id: newId(), name: `方案${n}`, fields: ["style", "fabric", "color"] as SkuField[] };
    save({ ...draft, sets: [...draft.sets, made] }); setPick(made.id); setNaming(null);
  };
  const remove = () => { save({ sets: draft.sets.filter(x => x.id !== set.id), default: draft.default === set.id ? SKU_AUTO : draft.default }); setPick(SKU_AUTO); };
  const rename = () => { const name = naming?.trim(); setNaming(null); if (name && name !== set.name) setOne({ name }); };
  const label = (x: SkuFieldSet) => (x.id === SKU_AUTO ? "不指定（系统自动挑）" : x.name) + (x.id === defaultId ? " · 默认" : "");
  const preview = auto ? [{ label: "货号", value: SAMPLE.style }, { label: "面料", value: SAMPLE.fabric }, { label: "颜色", value: SAMPLE.color }]
    : set.fields.map(f => ({ label: skuFieldName(f), value: SAMPLE[f] }));

  return (
    <section className="lp-ann" id="lp-s-fields">
      <div><h2>SKU 图左边写什么</h2><p>SKU 图左边、标题下面最多 3 行字。在这里存几个方案，每个方案定好第 1、2、3 行各写什么。</p>
        <p className="lp-small">勾了「新开的款默认用这个」的方案，新开的款就用它；每款在定方案第 ② 步还能换方案、改字（比如手写货号）。</p>
        <p className="lp-small">素材里没有的那一行就空着不放，不会编。出好的款在看图页「更多操作」点「按店铺设置重拼 SKU 图」，免费换上。</p></div>
      <div className="lp-card lp-pad lp-skufields">
        <div className="bar">
          <label className="lp-small">方案</label>
          {naming !== null && !auto
            ? <input className="lp-in" autoFocus value={naming} maxLength={SKU_SET_NAME_MAX} aria-label="方案名" onChange={e => setNaming(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === "Enter") rename(); }} />
            : <select className="lp-in" value={set.id} onChange={e => { setPick(e.target.value); setNaming(null); }}>{all.map(x => <option key={x.id} value={x.id}>{label(x)}</option>)}</select>}
          {!auto && naming === null && <button type="button" className="lp-btn sm ghost" onClick={() => setNaming(set.name)}>改名</button>}
          {draft.sets.length < SKU_SETS_MAX - 1 && <button type="button" className="lp-btn sm" onClick={add}>＋ 新建方案</button>}
          {!auto && <button type="button" className="lp-btn sm ghost" onClick={remove}>删除这个方案</button>}
        </div>
        <label className="lp-small def"><input type="checkbox" checked={set.id === defaultId} disabled={auto && set.id === defaultId}
          onChange={e => save({ ...draft, default: e.target.checked ? set.id : SKU_AUTO })} /> 新开的款默认用这个方案{auto && set.id === defaultId && draft.sets.length > 0 && <span className="lp-muted">（要换默认，先在上面选别的方案再勾）</span>}</label>
        <div className="body">
          <SkuLeftPreview rows={preview} />
          <div className="rows">
            {auto ? <p className="lp-say">{AUTO_SAYS}<br />想自己定每行写什么，点「＋ 新建方案」。</p>
              : rows.map((f, i) => (
                <label key={i} className="line"><span>第 {i + 1} 行</span>
                  <select className="lp-in" value={f} onChange={e => setRow(i, e.target.value as SkuField | "")}>
                    <option value="" disabled={set.fields.length <= 1 && !!f}>不放</option>
                    {SKU_FIELDS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>))}
            {!auto && <p className="lp-muted lp-small">左边是示例字（用 8826 的），实际出图时换成每款自己的。选了别的行已经有的字段，两行会对调。</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
