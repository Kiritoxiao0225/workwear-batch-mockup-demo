'use client';

/* eslint-disable @next/next/no-img-element */

import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useState } from 'react';
import Image from 'next/image';

import { simplePlacementGeometry, simpleGeometryIssue, simpleOffsetScale, simplePositionAnchor, simplePositionSource, simplePlacementLabel } from '@/lib/simple-batch';
import type { MockupTask, PlacementKey, Product } from '@/lib/types';

type DragState = {
  key: PlacementKey;
  startClientX: number;
  startClientY: number;
  startOffsetX: number;
  startOffsetY: number;
};

type MockupCanvasProps = {
  task: MockupTask;
  product: Product;
  activePosition: PlacementKey;
  onSelectPosition: (key: PlacementKey) => void;
  onMovePosition: (key: PlacementKey, offsetX: number, offsetY: number) => void;
  onResizePosition: (key: PlacementKey, widthCm: number) => void;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function MockupCanvas({
  task,
  product,
  activePosition,
  onSelectPosition,
  onMovePosition,
  onResizePosition,
}: MockupCanvasProps) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<{ key: PlacementKey; width: number; centerX: number; centerY: number; dx: number; dy: number } | null>(null);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});
  const logoUrlsKey = JSON.stringify([...new Set(Object.values(task.placements).flatMap(placement => placement ? [placement.logoUrl] : []))]);
  useEffect(() => {
    let disposed = false;
    for (const url of JSON.parse(logoUrlsKey) as string[]) {
      const image = new window.Image();
      image.onload = () => { if (!disposed) setRatios(current => ({ ...current, [url]: image.naturalWidth / image.naturalHeight })); };
      image.onerror = () => { if (!disposed) setFailedImages(current => ({ ...current, [url]: true })); };
      image.src = url;
    }
    return () => { disposed = true; };
  }, [logoUrlsKey]);
  const anchor = !task.placements[activePosition] ? simplePositionAnchor(task, activePosition) : null;
  const issues = Object.entries(task.placements).flatMap(([key, placement]) => {
    if (!placement) return [];
    if (failedImages[placement.logoUrl]) return [`${simplePlacementLabel(task, key as PlacementKey)} Logo 读取失败，请重新上传`];
    const ratio = ratios[placement.logoUrl];
    const issue = ratio ? simpleGeometryIssue(task, key as PlacementKey, placement, ratio) : null;
    return issue ? [issue] : [];
  });

  const pointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    key: PlacementKey,
  ) => {
    const placement = task.placements[key];
    if (!placement) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectPosition(key);
    setDrag({
      key,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: placement.offsetX,
      startOffsetY: placement.offsetY,
    });
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const board = event.currentTarget.closest('.mockup-stage');
    if (!board) return;
    const bounds = board.getBoundingClientRect();
    const scale = simpleOffsetScale(task, drag.key);
    const offsetX = drag.startOffsetX + ((event.clientX - drag.startClientX) / bounds.width / scale.x) * 100;
    const offsetY = drag.startOffsetY + ((event.clientY - drag.startClientY) / bounds.height / scale.y) * 100;
    onMovePosition(drag.key, clamp(offsetX, -45, 45), clamp(offsetY, -45, 45));
  };

  return (
    <div className="mockup-stage" style={{ aspectRatio: `${product.width} / ${product.height}` }}>
      <Image
        alt={`${product.code} ${product.name} 正反面商品素材`}
        fill
        priority
        sizes="(max-width: 760px) 100vw, 56vw"
        src={product.originalUrl}
        unoptimized={Boolean(task.garment)}
        onError={() => setFailedImages(current => ({ ...current, [product.originalUrl]: true }))}
      />
      {failedImages[product.originalUrl] && <div className="simple-canvas-errors" role="alert">衣服底图读取失败，请确认登录状态后重新打开页面。</div>}
      {issues.length > 0 && <div className="simple-canvas-errors" role="alert">{issues.map(issue => <p key={issue}>{issue}。可在右侧调整。</p>)}</div>}
      {anchor && <span className="simple-standard-anchor" style={{ left: `${anchor.x * 100}%`, top: `${anchor.y * 100}%` }}>{simplePlacementLabel(task, activePosition)} · {simplePositionSource(task, activePosition)}</span>}
      {Object.entries(task.placements).map(([rawKey, placement]) => {
        if (!placement) return null;
        const key = rawKey as PlacementKey;
        const ratio = ratios[placement.logoUrl];
        let geometry = null;
        try { if (ratio) geometry = simplePlacementGeometry(task, key, placement, ratio); } catch { /* Issue shown above; never preview a fallback position. */ }
        const onError = () => setFailedImages(current => ({ ...current, [placement.logoUrl]: true }));
        if (!geometry) return null;
        return (
          <div
            className={`logo-layer ${activePosition === key ? 'active' : ''}`}
            key={key}
            style={{
              left: `${geometry.centerX / product.width * 100}%`,
              top: `${geometry.centerY / product.height * 100}%`,
              width: `${geometry.width / product.width * 100}%`,
              transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`,
            }}
          >
            <button type="button" className="simple-logo-drag" aria-label={`移动${simplePlacementLabel(task, key)} Logo`}
              onClick={() => onSelectPosition(key)} onPointerCancel={() => setDrag(null)}
              onPointerDown={event => pointerDown(event, key)} onPointerMove={pointerMove} onPointerUp={() => setDrag(null)}>
              <img alt="" draggable={false} src={placement.logoUrl} onError={onError} />
              <span>{simplePlacementLabel(task, key)}</span>
            </button>
            {activePosition === key && (['nw', 'ne', 'sw', 'se'] as const).map(corner => <button
              key={corner} className={`simple-logo-resize ${corner}`} type="button"
              aria-label={`缩放${simplePlacementLabel(task, key)} Logo ${corner}`} title="拖动等比缩放"
              onPointerDown={event => {
                event.preventDefault(); event.stopPropagation(); setDrag(null);
                const board = event.currentTarget.closest('.mockup-stage')!.getBoundingClientRect();
                const centerX = board.left + geometry.centerX / product.width * board.width;
                const centerY = board.top + geometry.centerY / product.height * board.height;
                setResize({ key, width: placement.widthCm, centerX, centerY, dx: event.clientX - centerX, dy: event.clientY - centerY });
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={event => {
                const current = resize; if (!current || current.key !== key) return;
                const squared = current.dx * current.dx + current.dy * current.dy;
                if (squared < 1) return;
                const factor = ((event.clientX - current.centerX) * current.dx + (event.clientY - current.centerY) * current.dy) / squared;
                onResizePosition(key, Math.round(clamp(current.width * factor, .5, 100) * 100) / 100);
              }}
              onPointerUp={() => { setResize(null); }} onPointerCancel={() => { setResize(null); }}
              onKeyDown={event => {
                if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(event.key)) {
                  event.preventDefault();
                  onResizePosition(key, clamp(placement.widthCm + (['ArrowRight', 'ArrowUp'].includes(event.key) ? .5 : -.5), .5, 100));
                }
              }}
            />)}
          </div>
        );
      })}
    </div>
  );
}
