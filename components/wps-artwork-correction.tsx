'use client';
import { useState } from 'react';
import { artworkCorrectionIssues } from '@/lib/artwork-correction';
import type { ArtworkRoutingReport } from '@/lib/artwork-routing-standard';

export function WpsArtworkCorrection({ report, busy, submit }: { report?: ArtworkRoutingReport; busy: boolean; submit: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const issues = artworkCorrectionIssues(report);
  if (!issues.length) return null;
  return <div className="wps-inline-records">
    <button type="button" disabled={busy} onClick={() => { setOpen(!open); setSelected(issues.filter(issue => !issue.uncertain).map(issue => issue.id)); }}>按这些问题修正</button>
    {open && <div><p>选择本次要修正的问题。原图和当前结果会一起交给模型，保留当前版本供对照。</p>
      {issues.map(issue => <div key={issue.id}><label><input type="checkbox" checked={selected.includes(issue.id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current, issue.id] : current.filter(id => id !== issue.id))} />{issue.location}{issue.uncertain ? ' · 尚未查实' : ''}</label>
        <p>当前：{issue.actual}</p><p>预期：{issue.expected}</p><p>修正：{issue.action}</p><small>保留：{issue.preserve}</small></div>)}
      <p>提交会生成一张修正版，可能产生一次生图及所选抠图服务费用，不会自动连续重做。</p>
      <button type="button" className="button primary" disabled={busy || !selected.length} onClick={() => { submit(selected); setOpen(false); }}>提交所选问题修正</button>
      <button type="button" onClick={() => setOpen(false)}>收起</button>
    </div>}
  </div>;
}
