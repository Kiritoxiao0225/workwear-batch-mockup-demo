'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Copy,
  Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { CanvasElement, FONTS } from '@/lib/garment-editor/mockup-types';
import ColorPicker from '@/components/garment-editor/ColorPicker';

interface TextInspectorProps {
  element: CanvasElement;
  onUpdate: (updates: Partial<CanvasElement>) => void;
  onCopy: () => void;
  onDelete: () => void;
  compact?: boolean;
  dense?: boolean;
  mobilePanelMode?: 'basic' | 'advanced';
}

const DEFAULT_ARC_BEND = 60;
const MIN_LEGACY_ARC_RADIUS = 50;
const MAX_LEGACY_ARC_RADIUS = 300;
const TEXT_ALIGNMENTS = [
  { label: '左对齐', value: 'left' as const, icon: AlignLeft },
  { label: '居中', value: 'center' as const, icon: AlignCenter },
  { label: '右对齐', value: 'right' as const, icon: AlignRight },
];

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function bendToLegacyRadius(bend: number) {
  const clamped = clampNumber(bend, 0, 100);
  return Math.round(MAX_LEGACY_ARC_RADIUS - (clamped / 100) * (MAX_LEGACY_ARC_RADIUS - MIN_LEGACY_ARC_RADIUS));
}

function legacyArcRadiusToBend(radius?: number) {
  if (!Number.isFinite(radius)) return DEFAULT_ARC_BEND;
  const clamped = clampNumber(radius!, MIN_LEGACY_ARC_RADIUS, MAX_LEGACY_ARC_RADIUS);
  return Math.round(((MAX_LEGACY_ARC_RADIUS - clamped) / (MAX_LEGACY_ARC_RADIUS - MIN_LEGACY_ARC_RADIUS)) * 100);
}

function getArcBend(element: CanvasElement) {
  if (Number.isFinite(element.arcBend)) return clampNumber(element.arcBend!, 0, 100);
  return legacyArcRadiusToBend(element.arcRadius);
}

export default function TextInspector({ element, onUpdate, onCopy, onDelete, compact = false, dense = false, mobilePanelMode }: TextInspectorProps) {
  const selectedArcBend = getArcBend(element);
  const isArcText = !!element.arcMode && element.arcMode !== 'none';
  const isMobileBasic = mobilePanelMode === 'basic';
  const isMobileAdvanced = mobilePanelMode === 'advanced';
  const showTextInput = !isMobileAdvanced;
  const showFontColor = !compact && !isMobileAdvanced;
  const showStyle = !isMobileAdvanced;
  const showArcControls = !isMobileBasic || isArcText;
  const showSpacing = !compact && !isMobileBasic;
  const showActions = !compact && !isMobileBasic;
  const selectedTextAlign = element.textAlign ?? 'center';

  return (
    <div className={dense ? 'space-y-1.5' : compact ? 'space-y-2' : 'space-y-2.5'}>
      {showTextInput && (
        <input
          type="text"
          placeholder="输入文字..."
          value={element.text || ''}
          onChange={(e) => onUpdate({ text: e.target.value })}
          className={`w-full px-3 bg-canvas border border-border rounded-xl text-sm focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 transition-all outline-none ${dense ? 'py-2' : 'py-2.5'}`}
        />
      )}

      {showFontColor && (
        <div className={`grid grid-cols-2 ${dense ? 'gap-1.5' : 'gap-2'}`}>
          <div className="relative">
            <FontSelect
              value={element.fontFamily || FONTS[0].value}
              onChange={(value) => onUpdate({ fontFamily: value })}
            />
          </div>
          <ColorPicker
            color={element.textColor || '#000000'}
            gradient={element.textGradient}
            onChange={(color, grad) => onUpdate({ textColor: color, textGradient: grad })}
          />
        </div>
      )}

      {showStyle && (
        <>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mr-1">样式</span>
            <button
              onClick={() => onUpdate({ fontWeight: element.fontWeight === 'bold' ? 'normal' : 'bold' })}
              className={`${dense ? 'w-7 h-7' : 'w-8 h-8'} rounded-lg text-sm font-black transition-all border ${element.fontWeight === 'bold' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-ink-2 border-border hover:border-brand-300'}`}
              title="粗体"
            >B</button>
            <button
              onClick={() => onUpdate({ fontStyle: element.fontStyle === 'italic' ? 'normal' : 'italic' })}
              className={`${dense ? 'w-7 h-7' : 'w-8 h-8'} rounded-lg text-sm italic font-bold transition-all border ${element.fontStyle === 'italic' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-ink-2 border-border hover:border-brand-300'}`}
              title="斜体"
            >I</button>
            <button
              onClick={() => onUpdate({ textUnderline: !element.textUnderline })}
              className={`${dense ? 'w-7 h-7' : 'w-8 h-8'} rounded-lg text-sm underline font-bold transition-all border ${element.textUnderline ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-ink-2 border-border hover:border-brand-300'}`}
              title="下划线"
            >U</button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-ink-3 uppercase tracking-wider mr-1">对齐</span>
            {TEXT_ALIGNMENTS.map(alignment => {
              const AlignmentIcon = alignment.icon;
              const selected = selectedTextAlign === alignment.value;
              return (
                <button
                  key={alignment.value}
                  type="button"
                  onClick={() => onUpdate({ textAlign: alignment.value })}
                  aria-pressed={selected}
                  className={`${dense ? 'w-7 h-7' : 'w-8 h-8'} rounded-lg flex items-center justify-center transition-all border ${
                    selected
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-white text-ink-2 border-border hover:border-brand-300'
                  }`}
                  title={alignment.label}
                >
                  <AlignmentIcon size={dense ? 13 : 14} />
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className={`bg-canvas border border-border rounded-xl ${dense ? 'p-1.5 space-y-1.5' : 'p-2 space-y-2.5'}`}>
        <div className={dense ? 'space-y-1' : 'space-y-1.5'}>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-ink-3 uppercase tracking-wider">弧形</span>
            <span className="text-[10px] text-ink-3">{isArcText ? `${selectedArcBend}` : '关闭'}</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {([
              { label: '无', value: 'none' as const },
              { label: '上弧', value: 'down' as const },
              { label: '下弧', value: 'up' as const },
            ]).map(mode => (
              <button
                key={mode.value}
                onClick={() => onUpdate({
                  arcMode: mode.value,
                  arcBend: selectedArcBend,
                  arcRadius: bendToLegacyRadius(selectedArcBend),
                })}
                className={`${dense ? 'h-7' : 'h-8'} rounded-lg text-[11px] font-bold transition-all border ${
                  (element.arcMode || 'none') === mode.value
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-white text-ink-2 border-border hover:border-brand-300'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        {isArcText && !compact && showArcControls && (
          <>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-ink-3">弯曲</span>
                <span className="text-[10px] text-ink-3 font-mono">{selectedArcBend}</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={selectedArcBend}
                onChange={(e) => {
                  const bend = Number(e.target.value);
                  onUpdate({ arcBend: bend, arcRadius: bendToLegacyRadius(bend) });
                }}
                className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer"
                title={`弯曲: ${selectedArcBend}`}
              />
            </div>
            <div className="grid grid-cols-3 gap-1">
              {[
                { label: '轻弧', bend: 35 },
                { label: '招牌', bend: 70 },
                { label: '半圆', bend: 100 },
              ].map(preset => (
                <button
                  key={preset.label}
                  onClick={() => onUpdate({ arcBend: preset.bend, arcRadius: bendToLegacyRadius(preset.bend) })}
                  className={`${dense ? 'h-6' : 'h-7'} rounded-lg bg-white border border-border text-[10px] font-bold text-ink-3 hover:border-brand-300 hover:text-brand-600 transition-all`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </>
        )}

        {showSpacing && (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-ink-3">字间距</span>
              <span className="text-[10px] text-ink-3 font-mono">{element.letterSpacing || 0}</span>
            </div>
            <input
              type="range"
              min="0"
              max="50"
              value={element.letterSpacing || 0}
              onChange={(e) => onUpdate({ letterSpacing: Number(e.target.value) })}
              className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer"
              title={`字间距: ${element.letterSpacing || 0}`}
            />
          </div>
        )}
      </div>

      {showActions && (
        <div className={`grid grid-cols-2 ${dense ? 'gap-1.5' : 'gap-2'}`}>
          <button onClick={onCopy} className={`${dense ? 'h-8' : 'h-9'} rounded-xl bg-brand-50 text-brand-600 text-xs font-bold flex items-center justify-center gap-1.5`}>
            <Copy size={13} />
            复制
          </button>
          <button onClick={onDelete} className={`${dense ? 'h-8' : 'h-9'} rounded-xl bg-red-50 text-red-600 text-xs font-bold flex items-center justify-center gap-1.5`}>
            <Trash2 size={13} />
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function FontSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedFont = FONTS.find(f => f.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-canvas border border-border rounded-xl text-sm font-medium focus:ring-2 focus:ring-brand-500/30 outline-none cursor-pointer"
      >
        <span style={{ fontFamily: value }}>{selectedFont?.name || value}</span>
        <ChevronDown size={12} className={`text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="absolute z-50 w-full mt-1 bg-white border border-border rounded-xl shadow-lg max-h-48 overflow-y-auto"
          >
            {FONTS.map(font => (
              <button
                key={font.value}
                type="button"
                onClick={() => { onChange(font.value); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-canvas first:rounded-t-xl last:rounded-b-xl ${value === font.value ? 'bg-canvas font-medium' : ''}`}
              >
                {font.name}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
