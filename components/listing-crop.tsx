"use client";
/* eslint-disable @next/next/no-img-element -- the user's own picture, shown from a blob URL */
/**
 * 框选 a reference image (11-01): drag a box over the part the model should learn from, and only that
 * part is sent. 8826's colleague got the liner right only after cutting the front panel out by hand:
 * sent whole, the jacket's back lining was copied instead. The cut is made here in the browser from the
 * original, so the box can be drawn again later.
 */
import { useRef, useState } from "react";

/** A box in fractions of the picture: left, top, width, height. */
export type Box = [number, number, number, number];
const MIN = 0.04;

/** The part of the picture inside the box, as a JPEG file named after the original. */
export async function cropFile(file: File, box: Box): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const [l, t, w, h] = box, sx = Math.round(l * bitmap.width), sy = Math.round(t * bitmap.height);
  const sw = Math.max(1, Math.round(w * bitmap.width)), sh = Math.max(1, Math.round(h * bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = sw; canvas.height = sh;
  canvas.getContext("2d")!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await new Promise<Blob>((ok, fail) => canvas.toBlob(b => b ? ok(b) : fail(new Error("框选没成功，换一张图试试")), "image/jpeg", 0.92));
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + "-框选.jpg", { type: "image/jpeg" });
}

export function CropView({ src, initial, onDone, onWhole, onCancel }: {
  src: string; initial?: Box;
  /** The box drawn. */
  onDone: (box: Box) => void;
  /** 「用整张」: no box. */
  onWhole: () => void; onCancel: () => void;
}) {
  const [box, setBox] = useState<Box | null>(initial ?? null);
  const area = useRef<HTMLDivElement>(null), from = useRef<[number, number] | null>(null);
  const at = (e: React.PointerEvent): [number, number] => {
    const r = area.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const drag = (e: React.PointerEvent) => {
    if (!from.current) return;
    const [x0, y0] = from.current, [x1, y1] = at(e);
    setBox([Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]);
  };
  const ok = !!box && box[2] >= MIN && box[3] >= MIN;
  return (
    <div className="lp-crop">
      <p className="lp-small">按住拖一个框，框住要它学的那一块（比如只框衣服里面的内胆），只把框里的发过去。框歪了重新拖。</p>
      <div ref={area} className="lp-crop-area" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); from.current = at(e); setBox(null); }}
        onPointerMove={drag} onPointerUp={e => { drag(e); from.current = null; }}>
        <img src={src} alt="参考图" draggable={false} />
        {box && <div className="box" style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` }} />}
      </div>
      <div className="go">
        <button type="button" className="lp-btn primary sm" disabled={!ok} onClick={() => box && onDone(box)}>用框里的</button>
        <button type="button" className="lp-btn sm" onClick={onWhole}>不框了，用整张</button>
        <button type="button" className="lp-btn sm ghost" onClick={onCancel}>取消</button>
        {box && !ok && <span className="lp-muted lp-small">框太小了，拖大一点</span>}
      </div>
    </div>
  );
}
