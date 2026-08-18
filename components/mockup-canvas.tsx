'use client';

/* eslint-disable @next/next/no-img-element */

import type { PointerEvent as ReactPointerEvent } from 'react';
import { useState } from 'react';
import Image from 'next/image';

import { placementCenter, placementWidthRatio, PLACEMENT_LABELS } from '@/lib/mockup';
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
}: MockupCanvasProps) {
  const [drag, setDrag] = useState<DragState | null>(null);

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
    const board = event.currentTarget.parentElement;
    if (!board) return;
    const bounds = board.getBoundingClientRect();
    const offsetX = drag.startOffsetX + ((event.clientX - drag.startClientX) / bounds.width) * 100;
    const offsetY = drag.startOffsetY + ((event.clientY - drag.startClientY) / bounds.height) * 100;
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
      />
      {Object.entries(task.placements).map(([rawKey, placement]) => {
        if (!placement) return null;
        const key = rawKey as PlacementKey;
        const center = placementCenter(key, placement);
        const widthRatio = placementWidthRatio(placement, product);
        return (
          <button
            aria-label={`移动${PLACEMENT_LABELS[key]} Logo`}
            className={`logo-layer ${activePosition === key ? 'active' : ''}`}
            key={key}
            onClick={() => onSelectPosition(key)}
            onPointerCancel={() => setDrag(null)}
            onPointerDown={(event) => pointerDown(event, key)}
            onPointerMove={pointerMove}
            onPointerUp={() => setDrag(null)}
            style={{
              left: `${center.x * 100}%`,
              top: `${center.y * 100}%`,
              width: `${widthRatio * 100}%`,
              transform: `translate(-50%, -50%) rotate(${placement.rotation}deg)`,
            }}
            type="button"
          >
            <img alt="" draggable={false} src={placement.logoUrl} />
            <span>{PLACEMENT_LABELS[key]}</span>
          </button>
        );
      })}
    </div>
  );
}
