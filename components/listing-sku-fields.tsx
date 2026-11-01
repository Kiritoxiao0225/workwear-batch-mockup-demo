"use client";
/**
 * 店铺设置「SKU 图字段组合」(11-01): what the rows above the colour on the shop's SKU images say. The
 * shop saves named combos of fields (货号, 面料, 版型, 工艺, 适用场景, 颜色) in print order, at most
 * SKU_FIELD_MAX rows, and marks one the default for new products; each product may pick another on
 * its plan. 「自动」 is built in: the rule from before, and the default until another is marked.
 */
import { useRef, useState } from "react";
import {
  SKU_AUTO, SKU_AUTO_SET, SKU_FIELD_MAX, SKU_FIELDS, SKU_SET_NAME_MAX, SKU_SETS_MAX, skuFieldName,
  type SkuField, type SkuFieldSet, type SkuFieldSets,
} from "@/lib/listing/sku-card";

const AUTO_SAYS = "货号、面料、版型、工艺、适用场景里，这款有的前两个，再加颜色（和以前一样）";
const newId = () => "f" + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, "0")).join("");

export function SkuFieldsSection({ value, onSave }: { value: SkuFieldSets; onSave: (next: SkuFieldSets) => Promise<boolean> }) {
  // Edited here, saved a moment after the last change (names are typed); the server's copy wins after each save.
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(value); }
  const change = (next: SkuFieldSets, now = false) => {
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void onSave(next).then(ok => { if (!ok) setDraft(value); }); }, now ? 0 : 700);
  };
  const setOne = (id: string, patch: Partial<SkuFieldSet>) => change({ ...draft, sets: draft.sets.map(x => x.id === id ? { ...x, ...patch } : x) }, !("name" in patch));
  const add = () => {
    let n = draft.sets.length + 1;
    while (draft.sets.some(x => x.name === `组合${n}`)) n++;
    const id = newId();
    change({ ...draft, sets: [...draft.sets, { id, name: `组合${n}`, fields: ["style", "fabric", "color"] }] }, true);
  };
  const remove = (id: string) => change({ sets: draft.sets.filter(x => x.id !== id), default: draft.default === id ? SKU_AUTO : draft.default }, true);
  const move = (set: SkuFieldSet, i: number, by: number) => {
    const j = i + by; if (j < 0 || j >= set.fields.length) return;
    const fields = [...set.fields]; [fields[i], fields[j]] = [fields[j], fields[i]]; setOne(set.id, { fields });
  };
  const isDefault = (id: string) => draft.default === id || (id === SKU_AUTO && !draft.sets.some(x => x.id === draft.default));

  const card = (set: SkuFieldSet) => {
    const auto = set.id === SKU_AUTO, left = SKU_FIELDS.filter(([f]) => !set.fields.includes(f));
    return (
      <div key={set.id} className={"lp-skufields-set" + (isDefault(set.id) ? " on" : "")}>
        <div className="head">
          {auto ? <b>{SKU_AUTO_SET.name}<small>自带</small></b>
            : <input className="lp-in" value={set.name} maxLength={SKU_SET_NAME_MAX} aria-label="组合名" onChange={e => setOne(set.id, { name: e.target.value })} />}
          <span className="grow" />
          {isDefault(set.id) ? <span className="chip">默认</span>
            : <button type="button" className="lp-btn sm" onClick={() => change({ ...draft, default: set.id }, true)}>设为默认</button>}
          {!auto && <button type="button" className="lp-btn sm ghost" onClick={() => remove(set.id)}>删除</button>}
        </div>
        {auto ? <p className="lp-muted lp-small">{AUTO_SAYS}</p> : <>
          <ol className="rows">{set.fields.map((f, i) => (
            <li key={f}><span className="n">{i + 1}</span><b>{skuFieldName(f)}</b>
              <button type="button" className="lp-btn link" disabled={i === 0} aria-label="上移" onClick={() => move(set, i, -1)}>↑</button>
              <button type="button" className="lp-btn link" disabled={i === set.fields.length - 1} aria-label="下移" onClick={() => move(set, i, 1)}>↓</button>
              <button type="button" className="lp-btn link" disabled={set.fields.length <= 1} onClick={() => setOne(set.id, { fields: set.fields.filter(x => x !== f) })}>去掉</button></li>))}
          </ol>
          {set.fields.length < SKU_FIELD_MAX
            ? <div className="add"><span className="lp-muted lp-small">加一行：</span>{left.map(([f, name]) => <button type="button" key={f} className="lp-chip" onClick={() => setOne(set.id, { fields: [...set.fields, f as SkuField] })}>＋ {name}</button>)}</div>
            : <p className="lp-muted lp-small">最多 {SKU_FIELD_MAX} 行，去掉一行才能加别的。</p>}
        </>}
      </div>);
  };

  return (
    <section className="lp-ann" id="lp-s-fields">
      <div><h2>SKU 图字段组合</h2><p>SKU 图左边、标题下面那几行写什么：货号、面料、版型、工艺、适用场景、颜色，挑几个排好先后，存成组合。</p>
        <p className="lp-small">新开的款默认用标了「默认」的组合，每款在定方案第 ② 步还能单独换、能改每行的字（比如手写货号）。</p>
        <p className="lp-small">素材里没有的字段那一行就不放，不会编。改了以后新出的 SKU 图按新的来；出好的款在看图页「更多操作」里点「按店铺设置重拼 SKU 图」，免费。</p></div>
      <div className="lp-card lp-pad lp-skufields">
        {[SKU_AUTO_SET, ...draft.sets].map(card)}
        {draft.sets.length < SKU_SETS_MAX - 1 && <button type="button" className="lp-btn" onClick={add}>＋ 新建组合</button>}
      </div>
    </section>
  );
}
