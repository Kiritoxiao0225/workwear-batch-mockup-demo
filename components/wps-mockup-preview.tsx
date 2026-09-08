'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
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
  const [retry, setRetry] = useState(0);
  const output = version.output?.compositorVersion === WPS_COMPOSITOR_VERSION ? version.output : null;
  const previewUrl = `/api/catalog/production-preview?versionId=${encodeURIComponent(version.id)}&revision=${encodeURIComponent(productionPreviewRevision(version, units))}&retry=${retry}`;
  const url = `${previewUrl}&size=card`;
  const fullUrl = output?.url ?? previewUrl;
  const title = `${version.garment?.styleCode} · ${version.garment?.colorName} · ${version.variantLabel} · ${output ? '客户效果图' : '带框预览（未定稿）'}`;
  const scope = `${version.id}:${session.user?.id ?? 'signed-out'}`;
  const previewKey = `${scope}:${url}`;
  const [displayed, setDisplayed] = useState<{ key: string; scope: string; objectUrl: string } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const canLoad = Boolean(version.garment && session.initialized && session.user);
  useEffect(() => {
    if (paused || !canLoad) return;
    const controller = new AbortController();
    let pendingUrl: string | null = null;
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Preview HTTP ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        pendingUrl = URL.createObjectURL(blob);
        const image = new window.Image();
        image.src = pendingUrl;
        await image.decode();
        if (controller.signal.aborted) return;
        setDisplayed({ key: previewKey, scope, objectUrl: pendingUrl });
        pendingUrl = null;
      } catch {
        if (!controller.signal.aborted) setFailedKey(previewKey);
      } finally {
        if (pendingUrl) URL.revokeObjectURL(pendingUrl);
      }
    })();
    return () => controller.abort();
  }, [url, previewKey, scope, paused, canLoad]);
  useEffect(() => () => { if (displayed) URL.revokeObjectURL(displayed.objectUrl); }, [displayed]);
  if (!version.garment) return <div className="wps-garment-empty">选择款式和颜色后显示带框效果图</div>;
  const visible = displayed?.scope === scope && session.user ? displayed : null;
  const current = visible?.key === previewKey;
  const failed = failedKey === previewKey && !current;
  const notice = paused ? '位置调整完成后更新预览' : failed ? '新预览暂未读取，已保留上一版' : !current
    ? visible ? '正在更新 · 当前显示上一版' : '效果图更新中…' : composing ? '预览已更新，高清客户图保存中…' : null;
  const previewed = units.filter(unit => unit.artwork && unit.placement).length;
  const missingPosition = units.some(unit => unit.artwork && !unit.placement);
  return <div className="wps-framed-preview">
    {!session.initialized ? <div className="wps-image-notice" role="status">正在读取工作台登录状态…</div>
      : !session.user ? <div className="wps-image-notice"><strong>工作台连接暂不可用</strong><p>已保存的制作内容仍保留。</p><button type="button" onClick={() => void session.refresh()}>重新连接</button></div>
      : <>
        <button className="wps-output-preview" aria-label={`放大查看${title}`} disabled={!current || paused} type="button" onClick={() => open({ url: fullUrl, title })}>
          {visible && <Image alt={title} fill sizes="400px" src={visible.objectUrl} unoptimized />}
          {notice && <span className="wps-preview-status" role="status">{notice}</span>}
        </button>
        {failed && <div role="alert"><p>新预览暂时无法读取，制作状态已保留。</p><button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></div>}
      </>}
    <small>点击图片放大查看</small>
    <button className="wps-position-adjust" type="button" disabled={disabled} onClick={adjust}>调整位置</button>
    {!output && <small>{previewed}/{units.length} 个图案已上衣 · 预览，未定稿{missingPosition && <><br/>部分图案尚未选择印花位置</>}</small>}
  </div>;
}
