'use client';

import { useState } from 'react';
import type { RemoveMode } from '@/lib/server/listing-trash';
import { sizeText } from '@/lib/storage-status';

/**
 * 删除一款电商主图 (10-28): three ways, all into the 回收站 for 7 days. Used by the product list and
 * the 存储空间 page; the caller sends the request.
 */
export function RemoveDialog({ name, sourcesCleared, imagesCleared, freeableBytes, onConfirm, onClose }: {
  name: string; sourcesCleared: boolean; imagesCleared: boolean;
  /** What deleting the whole product gives back, when known. */
  freeableBytes?: number;
  onConfirm: (mode: RemoveMode) => Promise<void>; onClose: () => void;
}) {
  const [mode, setMode] = useState<RemoveMode>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options: { mode: RemoveMode; title: string; text: string; off?: string }[] = [
    { mode: 'sources', title: '只删原图', text: '删掉上传的原图，出好的图、方案和文案都留着，照样能看、能下载。以后要重新出图，得重新上传原图。',
      off: sourcesCleared ? '原图已经清理过了' : undefined },
    { mode: 'images', title: '只删图片', text: '原图和出好的图都删掉，解析、方案和文案留着，列表里还看得到这一款。（重新上传原图、接着用原方案出图的功能稍后上线）',
      off: imagesCleared ? '图片已经清理过了' : undefined },
    { mode: 'all', title: '整款删除', text: `这一款整个删掉，列表里不再显示。${freeableBytes !== undefined ? `大约腾出 ${sizeText(freeableBytes)}。` : ''}` },
  ];
  const go = async () => {
    setBusy(true); setError('');
    try { await onConfirm(mode); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }
  };
  return (
    <div className="remove-dialog" role="dialog" aria-modal="true" aria-label={`删除「${name}」`} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="remove-dialog__box">
        <h3>删除「{name}」</h3>
        <div className="remove-dialog__options" role="radiogroup">
          {options.map(option => (
            <label key={option.mode} className={`remove-dialog__option${mode === option.mode ? ' on' : ''}${option.off ? ' off' : ''}`}>
              <input type="radio" name="remove-mode" checked={mode === option.mode} disabled={!!option.off || busy} onChange={() => setMode(option.mode)} />
              <span><b>{option.title}</b><small>{option.off ?? option.text}</small></span>
            </label>
          ))}
        </div>
        <p className="remove-dialog__note">删了先放进回收站，<b>7 天内</b>可以在「我的账户 → 存储空间」里恢复；空间马上退回。已经扣的积分不退。</p>
        {error && <p className="remove-dialog__error" role="alert">{error}</p>}
        <div className="remove-dialog__actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="button danger" disabled={busy} autoFocus onClick={() => void go()}>{busy ? '正在删…' : '删除'}</button>
        </div>
      </div>
    </div>
  );
}
