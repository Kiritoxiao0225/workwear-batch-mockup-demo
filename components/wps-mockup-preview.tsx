'use client';

import Image from 'next/image';
import { useState } from 'react';
import type { ProductionMockupVersion, ProductionUnit } from '@/lib/wps-production';
import { WPS_COMPOSITOR_VERSION } from '@/lib/confirmation-frame';
import { useProjectSession } from '@/components/project-session';
import { productionPreviewRevision } from '@/lib/production-preview';

export function WpsMockupPreview({ version, units, open, adjust, disabled, paused, composing }: {
  version: ProductionMockupVersion; units: ProductionUnit[];
  revision?: number;
  open: (preview: { url: string; title: string }) => void;
  adjust: () => void;
  disabled?: boolean;
  paused?: boolean;
  composing?: boolean;
}) {
  const session = useProjectSession();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  if (!version.garment) return <div className="wps-garment-empty">选择款式和颜色后显示带框效果图</div>;
  const output = version.output?.compositorVersion === WPS_COMPOSITOR_VERSION ? version.output : null;
  const url = output?.url ?? `/api/catalog/production-preview?versionId=${encodeURIComponent(version.id)}&revision=${encodeURIComponent(productionPreviewRevision(version, units))}&retry=${retry}`;
  const title = `${version.garment.styleCode} · ${version.garment.colorName} · ${version.variantLabel} · ${output ? '客户效果图' : '带框预览（未定稿）'}`;
  const previewed = units.filter(unit => unit.artwork && unit.placement).length;
  const missingPosition = units.some(unit => unit.artwork && !unit.placement);
  const previewKey = `${url}:${session.user?.id ?? 'signed-out'}`;
  return <div className="wps-framed-preview">
    {paused || composing ? <div className="wps-image-notice" role="status">{composing ? '位置已保存，正在生成客户图…可继续处理其他衣服' : '位置调整完成后更新预览'}</div>
      : !output && !session.initialized ? <div className="wps-image-notice" role="status">正在读取工作台登录状态…</div>
      : !output && !session.user ? <div className="wps-image-notice"><strong>登录后查看服装效果</strong><p>已保存的制作内容仍保留。</p><button type="button" onClick={session.openLogin}>登录工作台</button></div>
      : failedUrl === previewKey ? <div className="wps-image-notice" role="alert"><strong>效果图暂时无法读取</strong><p>制作状态已保留，可重新加载预览。</p><button type="button" onClick={() => { setFailedUrl(null); setRetry(value => value + 1); }}>重新读取</button></div>
      : <button className="wps-output-preview" aria-label={`放大查看${title}`} type="button" onClick={() => open({ url, title })}>
        {loadedUrl !== previewKey && <span role="status">效果图更新中…</span>}
        <Image onLoad={() => setLoadedUrl(previewKey)} key={previewKey} alt={title} fill sizes="400px" src={url} unoptimized onError={() => setFailedUrl(previewKey)} />
      </button>}
    <small>点击图片放大查看</small>
    <button className="wps-position-adjust" type="button" disabled={disabled} onClick={adjust}>调整位置</button>
    {!output && <small>{previewed}/{units.length} 个图案已上衣 · 预览，未定稿{missingPosition && <><br/>部分图案尚未选择印花位置</>}</small>}
  </div>;
}
