'use client';

/* eslint-disable react-hooks/set-state-in-effect */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Saturation, Hue, Alpha, BACKGROUND_IMG,
  hexToHsva, hsvaToHex, hsvaToHexa, hsvaToRgba, rgbaToHsva, validHex,
} from '@uiw/react-color';
import type { HsvaColor } from '@uiw/color-convert';
import { X } from 'lucide-react';
import type { TextGradient, GradientStop } from '@/lib/garment-editor/mockup-types';

// ── Preset palette ──────────────────────────────────────────────
const PRESET_COLORS = [
  '#FFFFFF', '#FECACA', '#FED7AA', '#FEF08A', '#BBF7D0', '#BAE6FD', '#C7D2FE', '#F5D0FE',
  '#F3F4F6', '#FCA5A5', '#FDBA74', '#FDE047', '#86EFAC', '#7DD3FC', '#A5B4FC', '#E879F9',
  '#D1D5DB', '#F87171', '#FB923C', '#FACC15', '#4ADE80', '#38BDF8', '#818CF8', '#D946EF',
  '#9CA3AF', '#EF4444', '#F97316', '#EAB308', '#22C55E', '#0EA5E9', '#6366F1', '#A855F7',
  '#6B7280', '#DC2626', '#EA580C', '#CA8A04', '#16A34A', '#0284C7', '#4F46E5', '#9333EA',
  '#374151', '#B91C1C', '#C2410C', '#A16207', '#15803D', '#0369A1', '#4338CA', '#7E22CE',
  '#111827', '#7F1D1D', '#7C2D12', '#713F12', '#14532D', '#0C4A6E', '#312E81', '#581C87',
  '#000000', '#1C1917', '#292524', '#57534E', '#78716C', '#44403C', '#0C0A09',
];

function genId(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ── Types ────────────────────────────────────────────────────────
interface ColorPickerProps {
  color: string;
  gradient?: TextGradient;
  onChange: (color: string, gradient?: TextGradient) => void;
}

// ── Helper: build gradient preview CSS ──────────────────────────
function gradientCSS(stops: GradientStop[], angle: number): string {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  return `linear-gradient(${angle}deg, ${sorted.map(s => `${s.color} ${s.position}%`).join(', ')})`;
}

// ── Main component ───────────────────────────────────────────────
export default function ColorPicker({ color, gradient, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  const openPicker = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const top = Math.min(rect.top, window.innerHeight - 640);
      const isMobile = window.innerWidth < 768;
      const left = isMobile
        ? Math.max(8, (window.innerWidth - 288) / 2)
        : rect.right + 8;
      setPopupPos({ top: Math.max(8, top), left });
    }
    setOpen(true);
  };

  const solidColor = color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#000000';

  return (
    <>
      {/* Trigger button — shows current color or gradient */}
      <button
        ref={triggerRef}
        onClick={openPicker}
        className="w-full h-10 p-1 bg-white border border-border rounded-xl cursor-pointer overflow-hidden"
        style={{ background: gradient ? gradientCSS(gradient.stops, gradient.angle) : solidColor }}
        title="选择颜色"
      />

      {/* Floating picker via portal */}
      {mounted && open && createPortal(
        <ColorPickerPanel
          color={solidColor}
          gradient={gradient}
          onChange={onChange}
          onClose={() => setOpen(false)}
          style={{ position: 'fixed', top: popupPos.top, left: popupPos.left, zIndex: 9999 }}
        />,
        (document.getElementById('garment-editor-portals') || document.body)
      )}
    </>
  );
}

// ── Picker panel (the actual UI) ─────────────────────────────────
interface PanelProps {
  color: string;
  gradient?: TextGradient;
  onChange: (color: string, gradient?: TextGradient) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

function ColorPickerPanel({ color, gradient, onChange, onClose, style }: PanelProps) {
  const [mode, setMode] = useState<'solid' | 'gradient'>(gradient ? 'gradient' : 'solid');
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(color));

  const [gradientAngle, setGradientAngle] = useState<number>(gradient?.angle ?? 90);
  const [gradientStops, setGradientStops] = useState<GradientStop[]>(() => {
    if (gradient?.stops?.length) return gradient.stops;
    return [
      { id: genId(), color, position: 0 },
      { id: genId(), color: '#ffffff', position: 100 },
    ];
  });
  const [selectedStopId, setSelectedStopId] = useState<string>(
    () => gradient?.stops?.[0]?.id ?? gradientStops[0]?.id ?? ''
  );
  const [hexInput, setHexInput] = useState<string>(color.replace('#', ''));
  const [recentColors, setRecentColors] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('recentColors') ?? '[]');
    } catch (err) {
      console.warn('读取最近颜色失败:', err);
      return [];
    }
  });
  const [presetTab, setPresetTab] = useState<'preset' | 'recent'>('preset');

  const gradientBarRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startX: number; startPos: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Sync hexInput when hsva changes
  useEffect(() => {
    const h = hsva.a >= 1 ? hsvaToHex(hsva) : hsvaToHexa(hsva);
    setHexInput(h.replace('#', ''));
  }, [hsva]);

  // ── Emit ──────────────────────────────────────────────────────
  const emit = useCallback((
    newHsva: HsvaColor,
    newMode: 'solid' | 'gradient',
    newStops: GradientStop[],
    newAngle: number,
  ) => {
    const hex = newHsva.a >= 1 ? hsvaToHex(newHsva) : hsvaToHexa(newHsva);
    if (newMode === 'solid') {
      onChange(hex, undefined);
    } else {
      onChange(hex, { type: 'linear', angle: newAngle, stops: newStops });
    }
  }, [onChange]);

  // ── Color change handlers ──────────────────────────────────────
  const handleHsva = useCallback((newHsva: HsvaColor) => {
    setHsva(newHsva);
    if (mode === 'gradient' && selectedStopId) {
      const hex = newHsva.a >= 1 ? hsvaToHex(newHsva) : hsvaToHexa(newHsva);
      const newStops = gradientStops.map(s => s.id === selectedStopId ? { ...s, color: hex } : s);
      setGradientStops(newStops);
      emit(newHsva, 'gradient', newStops, gradientAngle);
    } else {
      emit(newHsva, mode, gradientStops, gradientAngle);
    }
  }, [mode, selectedStopId, gradientStops, gradientAngle, emit]);

  const handleHexInput = (val: string) => {
    const clean = val.replace('#', '').slice(0, 8);
    setHexInput(clean);
    if (validHex(clean)) {
      const nv = hexToHsva(`#${clean}`);
      handleHsva({ ...nv, a: hsva.a });
    }
  };

  const handleChannel = (ch: 'r' | 'g' | 'b' | 'a', raw: string) => {
    const max = ch === 'a' ? 100 : 255;
    const num = Math.min(max, Math.max(0, parseInt(raw) || 0));
    const rgba = hsvaToRgba(hsva);
    const newRgba = { ...rgba, [ch]: ch === 'a' ? num / 100 : num };
    handleHsva(rgbaToHsva(newRgba));
  };

  const addRecent = (hex: string) => {
    setRecentColors(prev => {
      const next = [hex, ...prev.filter(c => c !== hex)].slice(0, 16);
      try {
        localStorage.setItem('recentColors', JSON.stringify(next));
      } catch (err) {
        console.warn('保存最近颜色失败:', err);
      }
      return next;
    });
  };

  const applyPreset = (hex: string) => {
    const nv = { ...hexToHsva(hex), a: hsva.a };
    addRecent(hex);
    handleHsva(nv);
  };

  // ── Mode switch ────────────────────────────────────────────────
  const switchMode = (m: 'solid' | 'gradient') => {
    setMode(m);
    if (m === 'gradient' && gradientStops.length < 2) {
      const stops: GradientStop[] = [
        { id: genId(), color: hsvaToHex(hsva), position: 0 },
        { id: genId(), color: '#ffffff', position: 100 },
      ];
      setGradientStops(stops);
      setSelectedStopId(stops[0].id);
      emit(hsva, 'gradient', stops, gradientAngle);
    } else {
      emit(hsva, m, gradientStops, gradientAngle);
    }
  };

  const handleAngle = (v: number) => {
    const a = Math.max(0, Math.min(360, v));
    setGradientAngle(a);
    emit(hsva, mode, gradientStops, a);
  };

  // ── Gradient bar interactions ──────────────────────────────────
  const addStop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== gradientBarRef.current) return; // only if clicking bar, not stops
    const rect = gradientBarRef.current!.getBoundingClientRect();
    const pos = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    const stop: GradientStop = {
      id: genId(),
      color: hsvaToHex(hsva),
      position: Math.max(0, Math.min(100, pos)),
    };
    const newStops = [...gradientStops, stop].sort((a, b) => a.position - b.position);
    setGradientStops(newStops);
    setSelectedStopId(stop.id);
    emit(hsva, mode, newStops, gradientAngle);
  };

  const selectStop = (e: React.MouseEvent, stopId: string, pos: number) => {
    e.stopPropagation();
    setSelectedStopId(stopId);
    const s = gradientStops.find(x => x.id === stopId);
    if (s) setHsva(hexToHsva(s.color));
    dragRef.current = { id: stopId, startX: e.clientX, startPos: pos };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current || !gradientBarRef.current) return;
      const rect = gradientBarRef.current.getBoundingClientRect();
      const delta = ((e.clientX - dragRef.current.startX) / rect.width) * 100;
      const newPos = Math.max(0, Math.min(100, Math.round(dragRef.current.startPos + delta)));
      const newStops = gradientStops
        .map(s => s.id === dragRef.current!.id ? { ...s, position: newPos } : s)
        .sort((a, b) => a.position - b.position);
      setGradientStops(newStops);
      emit(hsva, mode, newStops, gradientAngle);
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [gradientStops, hsva, mode, gradientAngle, emit]);

  const removeStop = (id: string) => {
    if (gradientStops.length <= 2) return;
    const newStops = gradientStops.filter(s => s.id !== id);
    const fallback = newStops[0];
    if (selectedStopId === id) {
      setSelectedStopId(fallback.id);
      setHsva(hexToHsva(fallback.color));
    }
    setGradientStops(newStops);
    emit(hsva, mode, newStops, gradientAngle);
  };

  // ── Derived ───────────────────────────────────────────────────
  const rgba = hsvaToRgba(hsva);
  const currentHex = hsva.a >= 1 ? hsvaToHex(hsva) : hsvaToHexa(hsva);
  const sorted = [...gradientStops].sort((a, b) => a.position - b.position);

  return (
    <div
      ref={panelRef}
      style={style}
      className="w-72 bg-white rounded-2xl shadow-2xl border border-border overflow-hidden select-none"
    >
      {/* ── Header: tabs + close ── */}
      <div className="flex items-center p-2 gap-1 bg-canvas border-b border-border">
        {(['solid', 'gradient'] as const).map(m => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            className={`flex-1 py-1.5 text-xs font-bold rounded-xl transition-all ${
              mode === m ? 'bg-white text-ink shadow-sm' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {m === 'solid' ? '纯色' : '渐变'}
          </button>
        ))}
        <button onClick={onClose} className="ml-1 p-1.5 hover:bg-border rounded-lg transition-colors">
          <X size={14} className="text-ink-3" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* ── Gradient bar ── */}
        {mode === 'gradient' && (
          <div className="space-y-2">
            {/* Bar */}
            <div
              ref={gradientBarRef}
              onClick={addStop}
              className="relative h-7 rounded-lg cursor-crosshair"
              style={{
                background: gradientCSS(sorted, gradientAngle),
                border: '1px solid rgba(0,0,0,0.08)',
              }}
            >
              {sorted.map(stop => (
                <div
                  key={stop.id}
                  onMouseDown={e => selectStop(e, stop.id, stop.position)}
                  className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 rounded-full border-2 cursor-grab active:cursor-grabbing shadow ${
                    selectedStopId === stop.id ? 'border-white ring-2 ring-brand-500 scale-125' : 'border-white'
                  }`}
                  style={{ left: `${stop.position}%`, background: stop.color }}
                />
              ))}
            </div>
            {/* Angle + remove */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-ink-3 font-bold">角度</span>
              <input
                type="number" min={0} max={360} value={gradientAngle}
                onChange={e => handleAngle(parseInt(e.target.value) || 0)}
                className="w-14 px-2 py-1 text-xs border border-border rounded-lg text-center outline-none focus:ring-1 focus:ring-brand-500"
              />
              <span className="text-[10px] text-ink-3">°</span>
              {selectedStopId && gradientStops.length > 2 && (
                <button
                  onClick={() => removeStop(selectedStopId)}
                  className="ml-auto px-2 py-1 text-[10px] text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-red-100"
                >
                  删除色标
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Saturation square ── */}
        <Saturation
          hsva={hsva}
          onChange={c => handleHsva({ ...hsva, ...c })}
          style={{ width: '100%', paddingBottom: '66%', borderRadius: 8 }}
        />

        {/* ── Hue + Alpha sliders ── */}
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-full flex-shrink-0 border-2 border-border shadow-sm"
            style={{ background: currentHex }}
          />
          <div className="flex-1 space-y-2">
            <Hue
              hue={hsva.h}
              onChange={c => handleHsva({ ...hsva, ...c })}
              style={{ height: 10, borderRadius: 5 }}
            />
            {/* Alpha with checkerboard bg */}
            <div className="relative rounded overflow-hidden" style={{ height: 10 }}>
              <div
                className="absolute inset-0"
                style={{ backgroundImage: `url(${BACKGROUND_IMG})`, backgroundSize: '10px 10px' }}
              />
              <Alpha
                hsva={hsva}
                onChange={c => handleHsva({ ...hsva, ...c })}
                style={{ height: 10, borderRadius: 5 }}
              />
            </div>
          </div>
        </div>

        {/* ── Inputs: Hex + R G B A ── */}
        <div className="flex gap-1">
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <input
              value={hexInput}
              onChange={e => handleHexInput(e.target.value)}
              onBlur={() => validHex(hexInput) && addRecent(`#${hexInput.slice(0, 6)}`)}
              className="w-full px-2 py-1.5 text-[11px] border border-border rounded-lg text-center outline-none focus:ring-1 focus:ring-brand-500 font-mono"
              placeholder="000000"
              maxLength={9}
            />
            <span className="text-[9px] text-ink-3 text-center">Hex</span>
          </div>
          {(['r', 'g', 'b'] as const).map(ch => (
            <div key={ch} className="flex flex-col gap-0.5 w-11">
              <input
                type="number" min={0} max={255}
                value={Math.round(rgba[ch])}
                onChange={e => handleChannel(ch, e.target.value)}
                className="w-full px-1 py-1.5 text-[11px] border border-border rounded-lg text-center outline-none focus:ring-1 focus:ring-brand-500"
              />
              <span className="text-[9px] text-ink-3 text-center uppercase">{ch}</span>
            </div>
          ))}
          <div className="flex flex-col gap-0.5 w-11">
            <input
              type="number" min={0} max={100}
              value={Math.round(rgba.a * 100)}
              onChange={e => handleChannel('a', e.target.value)}
              className="w-full px-1 py-1.5 text-[11px] border border-border rounded-lg text-center outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="text-[9px] text-ink-3 text-center">A</span>
          </div>
        </div>

        {/* ── Preset / Recent tabs ── */}
        <div>
          <div className="flex gap-3 mb-2">
            {(['preset', 'recent'] as const).map(t => (
              <button
                key={t}
                onClick={() => setPresetTab(t)}
                className={`text-[10px] font-bold transition-colors ${
                  presetTab === t ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                {t === 'preset' ? '推荐颜色' : `最近使用${recentColors.length ? ` (${recentColors.length})` : ''}`}
              </button>
            ))}
          </div>

          {presetTab === 'preset' ? (
            <div className="grid grid-cols-8 gap-1">
              {PRESET_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => applyPreset(c)}
                  title={c}
                  className={`w-7 h-7 rounded-md transition-transform hover:scale-110 ${
                    currentHex.toLowerCase() === c.toLowerCase()
                      ? 'ring-2 ring-brand-500 ring-offset-1'
                      : 'border border-border'
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1 min-h-8">
              {recentColors.length === 0 ? (
                <span className="text-[10px] text-ink-3">暂无最近使用的颜色</span>
              ) : recentColors.map(c => (
                <button
                  key={c}
                  onClick={() => applyPreset(c)}
                  title={c}
                  className="w-7 h-7 rounded-md border border-border hover:scale-110 transition-transform"
                  style={{ background: c }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
