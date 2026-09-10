'use client';
import { productionThumbnailUrl } from '@/lib/production-file-url';
import { useState, type ReactNode } from 'react';
import type { ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { latestSharedArtwork, sharedArtworkCandidateKey, sharedArtworkFixed, sharedArtworkGroups, sharedArtworkSuggestions, sharedArtworkUnit } from '@/lib/shared-artwork';
import { productionPositionLabel } from '@/lib/production-garment';

type Props = {
  state: WpsProductionState; recordId: string;
  busy: (id: string) => string | null;
  make: (unit: ProductionUnit) => void; edit: (unit: ProductionUnit) => void;
  action: (input: Record<string, unknown>) => Promise<unknown>;
  progress: (id: string) => string;
  renderUnit: (unit: ProductionUnit) => { requirements: ReactNode; artwork: ReactNode };
};
export function WpsSharedArtworks({ state, recordId, busy, make, edit, action, progress, renderUnit }: Props) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [additional, setAdditional] = useState<Record<string, string[]>>({});
  const groups = sharedArtworkGroups(state).filter(group => group.sourceRecordId === recordId);
  const suggestions = sharedArtworkSuggestions(state, recordId);
  const standalone = state.units.filter(unit => unit.sourceRecordId === recordId && !unit.sharedArtworkId);
  const label = (unit: ProductionUnit) => `${unit.garmentLabel} · ${unit.placement ? productionPositionLabel(unit.placement) : '位置待定'}`;
  return <section className="wps-shared-workbench" aria-label="共用需求与图案制作">
    {suggestions.map(units => {
      const key = units[0].id;
      const source = units.find(unit => unit.id === chosen[key]) ?? units.find(unit => unit.artwork) ?? units[0];
      const blocked = units.map(unit => busy(unit.id)).find(Boolean);
      return <details className="wps-shared-suggestion" key={key}>
        <summary><span>{units.length} 处图案可共用</span><span>核对并合并 →</span></summary>
        <p>选择一份源稿，空白位置直接应用；已有不同图案与定稿会保留。</p>
        <label>源稿<select aria-label={`选择${key}的共用源稿`} value={source.id} onChange={event => setChosen(current => ({ ...current, [key]: event.target.value }))}>{units.map(unit => <option key={unit.id} value={unit.id}>{label(unit)}{unit.artwork ? ' · 已有图案' : ''}</option>)}</select></label>
        {units.map(unit => <p key={unit.id}><strong>{label(unit)}</strong><br/>{unit.instruction}</p>)}
        <button type="button" disabled={Boolean(blocked)} onClick={() => void action({ action: 'linkSharedArtwork', unitId: source.id, targetUnitIds: units.filter(unit => unit.id !== source.id).map(unit => unit.id) })}>共用这份图稿</button>
      </details>;
    })}
    {groups.map(group => {
      const unit = sharedArtworkUnit(state, group), source = state.units.find(item => item.id === group.sourceUnitId)!;
      const members = state.units.filter(unit => group.unitIds.includes(unit.id));
      const version = latestSharedArtwork(group);
      const available = state.units.filter(candidate => !candidate.sharedArtworkId && sharedArtworkCandidateKey(candidate) === sharedArtworkCandidateKey(unit));
      const updating = members.filter(member => !sharedArtworkFixed(state, member.id) && (!member.artwork || member.sharedArtworkVersion !== 0));
      const applied = members.filter(unit => unit.artwork && unit.sharedArtworkVersion === version?.number);
      const variants = applied.filter((unit, index) => applied.findIndex(other => other.artwork!.validation.sha256 === unit.artwork!.validation.sha256) === index);
      const reason = members.map(unit => busy(unit.id)).find(Boolean);
      const pending = version ? members.filter(unit => unit.sharedArtworkVersion !== version.number).length : 0;
      const names = [...new Set(members.map(unit => unit.garmentLabel))];
      const content = renderUnit(source);
      return <article className="wps-shared-design" key={group.id} data-shared-artwork-id={group.id}>
        <div className="wps-shared-requirement">
          <div className="wps-shared-title"><strong>{unit.placement ? productionPositionLabel(unit.placement) : '图稿'}</strong><span>{group.derivedFrom ? '独立版式' : `${members.length} 处共用`}</span></div>
          <p className="wps-shared-instruction">{unit.instruction}</p>
          {unit.exactText && !unit.instruction.includes(unit.exactText) && <p>{unit.exactText}</p>}
          <details className="wps-shared-scope"><summary>应用到 {names.length} 件衣服</summary><ul>{members.map(member => <li key={member.id}>{label(member)}</li>)}</ul></details>
          {unit.layoutNote && <details><summary>排版要求</summary><p>{unit.layoutNote}</p></details>}
          {available.length > 0 && <details className="wps-shared-add"><summary>＋ 添加应用</summary>
            {available.map(candidate => <label key={candidate.id}><input type="checkbox" checked={(additional[group.id] ?? []).includes(candidate.id)} disabled={Boolean(busy(candidate.id))}
              onChange={event => setAdditional(current => ({ ...current, [group.id]: event.target.checked ? [...(current[group.id] ?? []), candidate.id] : (current[group.id] ?? []).filter(id => id !== candidate.id) }))}/>{label(candidate)}{candidate.artwork ? ' · 已有稿保留' : ''}</label>)}
            <button type="button" disabled={Boolean(reason) || !(additional[group.id]?.length)} onClick={() => void action({ action: 'linkSharedArtwork', unitId: group.sourceUnitId, targetUnitIds: additional[group.id] }).then(() => setAdditional(current => ({ ...current, [group.id]: [] })))}>应用到所选位置</button>
          </details>}
          {pending > 0 && <p className="wps-shared-notice">{pending} 处保留原稿或待应用，可在衣服旁核对更新。</p>}
          <details className="wps-shared-history"><summary>要求与版本记录</summary>{content.requirements}{group.versions.map(item => <p key={item.number}>v{item.number} · {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.automaticTextColor ? '文字随衣服适配颜色' : '固定配色'}</p>)}</details>
        </div>
        <div className="wps-shared-making">
          <div className="wps-shared-thumbnails">{(variants.length ? variants : unit.artwork ? [unit] : []).map(variant => <button key={variant.id} className="wps-shared-thumbnail" type="button" disabled={Boolean(reason)} onClick={() => edit(unit)} title={`编辑共用稿，更新 ${updating.length} 处`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={productionThumbnailUrl(variant.artwork!.url)} alt={`${label(variant)}的图稿配色`} />
            {variants.length > 1 && <small>{variant.garment?.colorName || variant.garmentLabel}</small>}
          </button>)}</div>
          <div className="wps-shared-design-state"><span>{unit.artwork ? applied.length > 0 && applied.every(member => member.gateB) ? '图案已核对' : '已制作 · 待核对' : '待制作'}{version ? ` · v${version.number}` : ''}</span></div>
          <div className="wps-shared-primary-actions">
            {unit.artwork ? <button className="wps-shared-edit" type="button" disabled={Boolean(reason)} onClick={() => edit(unit)} title={`保存后更新 ${updating.length} 处；已定稿保留原版`}>编辑共用稿</button> : unit.route !== 'gpt-image-2' && <button className="wps-shared-edit" type="button" disabled={Boolean(reason)} onClick={() => make(source)}>制作共用稿</button>}
            {members.some(unit => !unit.gateB && unit.artwork && unit.sharedArtworkVersion === version?.number && !sharedArtworkFixed(state, unit.id)) && <button type="button" disabled={Boolean(reason)} onClick={() => void action({ action: 'confirmSharedArtwork', unitId: group.sourceUnitId, actor: '当前操作员' })}>确认图案</button>}
          </div>
          {(reason || progress(group.sourceUnitId)) && <p role="status" className="wps-shared-notice">{reason || progress(group.sourceUnitId)}</p>}
          <details className="wps-shared-recovery" open={unit.route === 'gpt-image-2' || Boolean(progress(group.sourceUnitId))}><summary>制作设置与记录</summary>{content.artwork}</details>
        </div>
      </article>;
    })}
    {standalone.map(unit => { const content = renderUnit(unit); return <article className="wps-shared-design wps-standalone-design" key={unit.id}>
      <div className="wps-requirement-cell"><small className="wps-standalone-label">{unit.garmentLabel} · 单独制作</small>{content.requirements}</div>
      <div className="wps-artwork-cell">{content.artwork}</div>
    </article>; })}
  </section>;
}
