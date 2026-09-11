'use client';
import { useState } from 'react';
import { reviewStateLabels, type ArtworkReviewLedger, type ReviewCategory } from '@/lib/artwork-review-ledger';

export function WpsArtworkChecklist({ review, busy, readOnly, submit }: {
  review: ArtworkReviewLedger; busy: boolean; readOnly: boolean;
  submit: (mode: 'automatic' | 'accepted' | 'confirmed', itemIds: ReviewCategory[], note: string, actor: string) => void;
}) {
  const [selected, setSelected] = useState<ReviewCategory[]>([]);
  const [note, setNote] = useState('');
  const [actor, setActor] = useState('');
  const automatic = review.items.filter(item => !['size', 'position'].includes(item.id) && ['pending', 'uncertain', 'failed'].includes(item.status));
  return <details className="wps-inline-records wps-artwork-checklist"><summary>逐项核对与人工记录</summary>
    <p>核对当前保存的图案。待修正或看不清的项目仍可编辑、上衣和下载。</p>
    {review.items.map(item => <div key={item.id} style={{ marginBottom: 12 }}>
      <label><input type="checkbox" disabled={busy || readOnly} checked={selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/>{item.label} · <strong>{reviewStateLabels[item.status]}</strong></label>
      <p>{item.evidence}</p>{item.actor && <small>{item.actor} · {item.note} · {item.checkedAt}</small>}
      <details><summary>对应要求</summary><p>{item.requirement}</p></details>
    </div>)}
    {!readOnly && <div className="wps-artwork-checklist-actions">
      <button type="button" disabled={busy || !automatic.length} onClick={() => submit('automatic', automatic.map(item => item.id), '', '')}>核对当前图案的待处理项</button>
      <small>仅核对，不重新生图。尺寸和位置请对照上衣预览人工核对。</small>
      <label>核对人（登录时自动记录账号）<input value={actor} maxLength={100} disabled={busy} onChange={event => setActor(event.target.value)}/></label>
      <label>核对或接受差异的说明<textarea value={note} maxLength={2000} disabled={busy} onChange={event => setNote(event.target.value)}/></label>
      <button type="button" disabled={busy || !selected.length || !note.trim()} onClick={() => submit('confirmed', selected, note, actor)}>所选项目人工核对符合</button>
      <button type="button" disabled={busy || !selected.length || !note.trim()} onClick={() => submit('accepted', selected, note, actor)}>接受所选差异</button>
      <small>人工决定保留记录；客户定稿仍通过原有操作完成。</small>
    </div>}
    {review.history.length > 0 && <details><summary>历史核对（{review.history.length} 次）</summary>{review.history.map((entry, index) => <div key={index}><small>{entry.at} · 图片 {entry.sha256.slice(0, 12)}</small><ul>{entry.items.map(item => <li key={item.id}>{item.label}：{reviewStateLabels[item.status]} · {item.evidence}{item.actor && ` · ${item.actor}：${item.note}`}</li>)}</ul></div>)}</details>}
  </details>;
}
