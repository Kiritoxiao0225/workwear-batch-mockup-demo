'use client';
import { productionThumbnailUrl } from '@/lib/production-file-url';
import { useState, type ReactNode } from 'react';
import type { ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { latestSharedArtwork, sharedArtworkCandidateKey, sharedArtworkFixed, sharedArtworkGroups, sharedArtworkSuggestions, sharedArtworkUnit } from '@/lib/shared-artwork';
import { productionPositionLabel } from '@/lib/production-garment';
import { sharedArtworkStatus, productionActionError, type ProductionActionFeedback } from '@/lib/shared-artwork-status';

type Props = {
  state: WpsProductionState; recordId: string;
  busy: (id: string) => string | null;
  make: (unit: ProductionUnit) => void; edit: (unit: ProductionUnit) => void;
  preview: (url: string, title: string) => void;
  action: (input: Record<string, unknown>) => Promise<unknown>;
  progress: (id: string) => string;
  error: (id: string) => string;
  feedback: (id: string) => ProductionActionFeedback | undefined;
  refresh: (id: string) => Promise<void>;
  renderUnit: (unit: ProductionUnit, shared?: boolean) => { requirements: ReactNode; artwork: ReactNode };
};
export function WpsSharedArtworks({ state, recordId, busy, make, edit, preview, action, progress, error, feedback, refresh, renderUnit }: Props) {
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
        <summary><span>{units.length} 处相似图案</span><span>手动共用选项 →</span></summary>
        <p>相同要求的未制作图案会自动共用。这些位置存在不同要求或已有制作记录，保留独立；需要共用时可选择源稿。</p>
        <label>源稿<select aria-label={`选择${key}的共用源稿`} value={source.id} onChange={event => setChosen(current => ({ ...current, [key]: event.target.value }))}>{units.map(unit => <option key={unit.id} value={unit.id}>{label(unit)}{unit.artwork ? ' · 已有图案' : ''}</option>)}</select></label>
        {units.map(unit => <p key={unit.id}><strong>{label(unit)}</strong><br/>{unit.instruction}</p>)}
        <button type="button" disabled={Boolean(blocked)} onClick={() => void action({ action: 'linkSharedArtwork', unitId: source.id, targetUnitIds: units.filter(unit => unit.id !== source.id).map(unit => unit.id) })}>{blocked || '共用这份图稿'}</button>
        {feedback(source.id) && <p role="status">{feedback(source.id)!.message}</p>}
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
      const status = sharedArtworkStatus(state, group);
      const operation = members.map(member => feedback(member.id)).find(item => item && item.status !== 'saved') ?? feedback(group.sourceUnitId);
      const generationError = error(group.sourceUnitId);
      const working = progress(group.sourceUnitId);
      const names = [...new Set(members.map(unit => unit.garmentLabel))];
      const content = renderUnit(unit, true);
      return <article className="wps-shared-design" key={group.id} data-shared-artwork-id={group.id}>
        <div className="wps-shared-requirement">
          <div className="wps-shared-title"><strong>{unit.placement ? productionPositionLabel(unit.placement) : '图稿'}</strong><span>{group.derivedFrom ? '独立版式' : `${members.length} 处${group.automatic ? '自动' : ''}共用`}</span></div>
          <p className="wps-shared-instruction">{unit.instruction}</p>
          {unit.exactText && !unit.instruction.includes(unit.exactText) && <p>{unit.exactText}</p>}
          <details className="wps-shared-scope"><summary>应用到 {names.length} 件衣服</summary><ul>{members.map(member => <li key={member.id}>{label(member)}</li>)}</ul></details>
          {unit.layoutNote && <details><summary>排版要求</summary><p>{unit.layoutNote}</p></details>}
          {available.length > 0 && <details className="wps-shared-add"><summary>＋ 添加应用</summary>
            {available.map(candidate => <label key={candidate.id}><input type="checkbox" checked={(additional[group.id] ?? []).includes(candidate.id)} disabled={Boolean(busy(candidate.id))}
              onChange={event => setAdditional(current => ({ ...current, [group.id]: event.target.checked ? [...(current[group.id] ?? []), candidate.id] : (current[group.id] ?? []).filter(id => id !== candidate.id) }))}/>{label(candidate)}{candidate.artwork ? ' · 已有稿保留' : ''}</label>)}
            <button type="button" disabled={Boolean(reason) || !(additional[group.id]?.length)} onClick={() => void action({ action: 'linkSharedArtwork', unitId: group.sourceUnitId, targetUnitIds: additional[group.id] }).then(result => { if (result) setAdditional(current => ({ ...current, [group.id]: [] })); })}>应用到所选位置</button>
          </details>}
          <details className="wps-shared-history"><summary>要求与版本记录</summary>{content.requirements}{group.versions.map(item => <p key={item.number}>v{item.number} · {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.automaticTextColor ? '文字随衣服适配颜色' : '固定配色'}</p>)}</details>
        </div>
        <div className="wps-shared-making">
          <div className="wps-shared-thumbnails">{(variants.length ? variants : unit.artwork ? [unit] : []).map(variant => <button key={variant.id} className="wps-shared-thumbnail" type="button" onClick={() => preview(variant.artwork!.url, `${label(variant)} · 已保存的图案`)} title={`放大查看${label(variant)}的实际图案`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={productionThumbnailUrl(variant.artwork!.url)} alt={`${label(variant)}的图稿配色`} />
            {variants.length > 1 && <small>{variant.garment?.colorName || variant.garmentLabel}</small>}
          </button>)}</div>
          <div className={`wps-shared-design-state ${status.complete && version ? 'complete' : ''}`} role="status" aria-live="polite">
            <strong>{operation?.status === 'unknown' ? '本次操作结果待核实' : reason || working || (version ? status.complete ? '共用图案已确认' : `图稿已保存 · v${version.number}` : '待制作共用图案')}</strong>
            <span>{operation?.status === 'unknown' ? '上次读取：' : ''}{status.summary}</span>
          </div>
          {operation && <div className={`wps-shared-operation ${operation.status}`} role={operation.status === 'error' || operation.status === 'unknown' ? 'alert' : 'status'}>
            <p>{operation.message}</p>
            {['error', 'unknown'].includes(operation.status) && <button type="button" onClick={() => void refresh(members.find(member => feedback(member.id) === operation)?.id ?? group.sourceUnitId)}>重新检查状态</button>}
            {operation.detail && <details><summary>错误详情</summary><p>{operation.detail}</p></details>}
          </div>}
          {generationError && !working && <p className="wps-shared-notice" role="alert">本次制作未完成：{productionActionError(generationError)}。{version ? '已保存的共用稿仍保留。' : ''}展开下方记录处理。</p>}
          <ul className="wps-shared-applications" aria-label="各位置应用结果">{status.applications.map(item => <li key={item.unit.id}>
            <div><span>{label(item.unit)}</span><strong className={item.error ? 'needs-attention' : item.confirmed || item.fixed ? 'complete' : ''}>{item.status}</strong></div>
            {item.error && <p>{productionActionError(item.error)}</p>}
            {item.canApply && <button type="button" disabled={Boolean(reason)} onClick={() => void action({ action: 'applySharedArtwork', unitId: item.unit.id })}>{item.error ? '重试应用（不重新制作）' : `应用共用稿 v${version!.number}`}</button>}
          </li>)}</ul>
          <div className="wps-shared-primary-actions">
            {unit.artwork ? <button className="wps-shared-edit" type="button" disabled={Boolean(reason)} onClick={() => edit(unit)} title={`保存后更新 ${updating.length} 处；已定稿保留原版`}>编辑共用稿</button> : unit.route !== 'gpt-image-2' && <button className="wps-shared-edit" type="button" disabled={Boolean(reason)} onClick={() => make(source)}>制作共用稿</button>}
            {status.confirmable > 0 && <button type="button" disabled={Boolean(reason)} onClick={() => void action({ action: 'confirmSharedArtwork', unitId: group.sourceUnitId, actor: '当前操作员' })}>{operation?.status === 'saving' && operation.message.startsWith('正在确认') ? '正在确认…' : `确认 ${status.confirmable} 处图案`}</button>}
          </div>
          {version && <p className="wps-shared-next">{status.complete ? '图案这一步已完成。下一步在衣服旁核对位置，生成客户图。' : status.confirmable ? '核对上方图形、文字和配色后，一次确认这些位置。' : '请先处理上方待应用或待修正的位置。'}</p>}
          <details className="wps-shared-recovery" open={unit.route === 'gpt-image-2' || Boolean(generationError || working)}><summary>{unit.artwork ? '重新制作、设置与历史记录' : '制作设置与记录'}</summary>{content.artwork}</details>
        </div>
      </article>;
    })}
    {standalone.map(unit => { const content = renderUnit(unit); return <article className="wps-shared-design wps-standalone-design" key={unit.id}>
      <div className="wps-requirement-cell"><small className="wps-standalone-label">{unit.garmentLabel} · 单独制作</small>{content.requirements}</div>
      <div className="wps-artwork-cell">{content.artwork}</div>
    </article>; })}
  </section>;
}
