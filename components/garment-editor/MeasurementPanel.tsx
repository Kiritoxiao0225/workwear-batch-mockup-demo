'use client';

import { Crosshair, Ruler, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type {
  MeasurementAxis,
  MockupDimension,
  MockupGuide,
  MockupMeasurementState,
} from '@/lib/garment-editor/mockup-types';
import {
  guidePositionCm,
  measurementDistanceCm,
} from '@/lib/garment-editor/mockup-measurements';

function formatCm(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export interface PendingMeasurementCalibration {
  axis: MeasurementAxis;
  firstSceneCoordinate: number;
  secondSceneCoordinate: number;
}

export default function MeasurementPanel({
  measurements,
  guides,
  dimensions,
  selectedGuideId,
  dimensionStartGuideId,
  calibrationDraftActive,
  calibrationDraftPointCount,
  pendingCalibration,
  onClose,
  onStartCalibration,
  onCancelCalibration,
  onConfirmCalibration,
  onSelectGuide,
  onUpdateGuidePosition,
  onDeleteGuide,
  onCreateOffsetGuide,
  onSetDimensionStart,
  onCreateDimension,
  onDeleteDimension,
}: {
  measurements: MockupMeasurementState;
  guides: MockupGuide[];
  dimensions: MockupDimension[];
  selectedGuideId: string | null;
  dimensionStartGuideId: string | null;
  calibrationDraftActive: boolean;
  calibrationDraftPointCount: number;
  pendingCalibration: PendingMeasurementCalibration | null;
  onClose: () => void;
  onStartCalibration: () => void;
  onCancelCalibration: () => void;
  onConfirmCalibration: (distanceCm: number) => void;
  onSelectGuide: (guideId: string) => void;
  onUpdateGuidePosition: (guideId: string, positionCm: number) => void;
  onDeleteGuide: (guideId: string) => void;
  onCreateOffsetGuide: (
    guideId: string,
    direction: 'negative' | 'positive',
    offsetCm: number
  ) => void;
  onSetDimensionStart: (guideId: string | null) => void;
  onCreateDimension: (guideAId: string, guideBId: string) => void;
  onDeleteDimension: (dimensionId: string) => void;
}) {
  const [calibrationLength, setCalibrationLength] = useState('52');
  const [guidePositionDraft, setGuidePositionDraft] = useState<{
    guideId: string;
    value: string;
  } | null>(null);
  const [offsetCm, setOffsetCm] = useState('4');
  const [offsetDirection, setOffsetDirection] = useState<
    'negative' | 'positive'
  >('positive');
  const selectedGuide =
    guides.find(guide => guide.id === selectedGuideId) ?? null;
  const selectedGuidePosition =
    selectedGuide && measurements.scale
      ? guidePositionCm(measurements, selectedGuide)
      : null;
  const guidePosition = selectedGuide
    ? guidePositionDraft?.guideId === selectedGuide.id
      ? guidePositionDraft.value
      : selectedGuidePosition === null
        ? ''
        : formatCm(selectedGuidePosition)
    : '';
  const dimensionStartGuide =
    guides.find(guide => guide.id === dimensionStartGuideId) ?? null;
  const canCreateDimension =
    !!measurements.scale &&
    !!selectedGuide &&
    !!dimensionStartGuide &&
    selectedGuide.id !== dimensionStartGuide.id &&
    selectedGuide.axis === dimensionStartGuide.axis;

  const dimensionRows = useMemo(
    () =>
      dimensions.flatMap(dimension => {
        const guideA = guides.find(guide => guide.id === dimension.guideAId);
        const guideB = guides.find(guide => guide.id === dimension.guideBId);
        if (!guideA || !guideB) return [];
        return [
          {
            ...dimension,
            label: `${guideA.label} ↔ ${guideB.label}`,
            distanceCm: measurements.scale
              ? measurementDistanceCm(measurements, guideA, guideB)
              : null,
          },
        ];
      }),
    [dimensions, guides, measurements]
  );

  const submitCalibration = () => {
    const distance = Number(calibrationLength);
    if (Number.isFinite(distance) && distance > 0) {
      onConfirmCalibration(distance);
    }
  };

  const submitGuidePosition = () => {
    if (!selectedGuide) return;
    const position = Number(guidePosition);
    if (Number.isFinite(position)) {
      onUpdateGuidePosition(selectedGuide.id, position);
    }
  };

  const submitOffset = () => {
    if (!selectedGuide) return;
    const offset = Number(offsetCm);
    if (Number.isFinite(offset) && offset > 0) {
      onCreateOffsetGuide(selectedGuide.id, offsetDirection, offset);
    }
  };

  const calibrationInProgress =
    calibrationDraftActive || pendingCalibration !== null;

  return (
    <section
      className="absolute right-4 top-10 z-50 hidden w-80 max-h-[calc(100%-64px)] overflow-y-auto rounded-2xl border border-border bg-white/95 p-3 shadow-2xl backdrop-blur-xl md:block"
      aria-label="标尺与测量"
    >
      <header className="flex items-start gap-2 border-b border-border pb-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <Ruler size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-ink">标尺与测量</h3>
          <p className="truncate text-[10px] text-ink-3">
            整个画布共用一套厘米比例尺
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-ink-3 hover:bg-canvas hover:text-ink"
          aria-label="关闭标尺"
        >
          <X size={15} />
        </button>
      </header>

      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-2 text-[10px] leading-relaxed text-amber-800">
        先用一段已知实物距离设置比例尺。画布缩放不影响厘米值；缩放商品图后应重新设置比例尺。
      </div>

      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-bold text-ink">1. 比例尺</span>
          {calibrationInProgress && (
            <button
              type="button"
              onClick={onCancelCalibration}
              className="text-[10px] font-medium text-red-600 hover:text-red-700"
            >
              取消
            </button>
          )}
        </div>

        {measurements.scale ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold text-emerald-800">
                  已设置 · 横纵统一比例
                </p>
                <p className="mt-0.5 text-[10px] tabular-nums text-emerald-700">
                  参考距离 {formatCm(measurements.scale.distanceCm)} cm
                </p>
              </div>
              <button
                type="button"
                onClick={onStartCalibration}
                className="rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100"
              >
                修改比例尺
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-brand-200 bg-brand-50 p-2">
            {guides.length > 0 && (
              <p className="mb-2 text-[10px] leading-relaxed text-brand-700">
                旧版基准线已保留，请重新设置一次统一比例尺。
              </p>
            )}
            <button
              type="button"
              onClick={onStartCalibration}
              className="w-full rounded-lg bg-brand-600 py-2 text-[11px] font-semibold text-white hover:bg-brand-700"
            >
              设置比例尺
            </button>
          </div>
        )}

        {calibrationDraftActive && !pendingCalibration && (
          <p className="mt-2 rounded-lg bg-brand-50 px-2 py-1.5 text-[10px] text-brand-700">
            请点击已知水平或垂直距离的两个端点（已选 {calibrationDraftPointCount}/2 点）。
          </p>
        )}
        {pendingCalibration && (
          <div className="mt-2 rounded-xl border border-brand-200 bg-brand-50 p-2">
            <label className="text-[10px] font-semibold text-brand-800">
              这段距离实际是多少（cm）
            </label>
            <div className="mt-1 flex gap-1.5">
              <input
                value={calibrationLength}
                onChange={event => setCalibrationLength(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') submitCalibration();
                }}
                inputMode="decimal"
                className="min-w-0 flex-1 rounded-lg border border-brand-200 bg-white px-2 py-1.5 text-xs tabular-nums outline-none focus:border-brand-500"
              />
              <button
                type="button"
                onClick={submitCalibration}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-700"
              >
                确认
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-bold text-ink">2. 基准线</span>
          <span className="text-[9px] text-ink-3">从上/左标尺拖入画布</span>
        </div>
        {guides.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-[10px] text-ink-3">
            设置比例尺后会生成两条基准线，也可继续从标尺拖出新线。
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {guides.map(guide => {
              const positionCm = measurements.scale
                ? guidePositionCm(measurements, guide)
                : null;
              return (
                <button
                  key={guide.id}
                  type="button"
                  onClick={() => onSelectGuide(guide.id)}
                  className={`rounded-lg border px-2 py-1.5 text-[10px] font-semibold tabular-nums ${
                    selectedGuideId === guide.id
                      ? 'border-orange-400 bg-orange-50 text-orange-700'
                      : 'border-cyan-200 bg-cyan-50 text-cyan-700 hover:border-cyan-400'
                  }`}
                >
                  {guide.label}
                  {positionCm === null
                    ? ' · 待设置'
                    : ` · ${formatCm(positionCm)} cm`}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedGuide && measurements.scale && (
        <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50/60 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-orange-800">
              当前：{selectedGuide.label}
            </span>
            <button
              type="button"
              onClick={() => onDeleteGuide(selectedGuide.id)}
              className="rounded p-1 text-red-600 hover:bg-red-50"
              aria-label={`删除 ${selectedGuide.label}`}
            >
              <Trash2 size={13} />
            </button>
          </div>

          <label className="mt-2 block text-[9px] font-medium text-ink-3">
            相对坐标（cm）
          </label>
          <div className="mt-1 flex gap-1.5">
            <input
              value={guidePosition}
              onChange={event =>
                setGuidePositionDraft({
                  guideId: selectedGuide.id,
                  value: event.target.value,
                })
              }
              onKeyDown={event => {
                if (event.key === 'Enter') submitGuidePosition();
              }}
              inputMode="decimal"
              className="min-w-0 flex-1 rounded-lg border border-border bg-white px-2 py-1.5 text-xs tabular-nums outline-none focus:border-orange-400"
            />
            <button
              type="button"
              onClick={submitGuidePosition}
              className="rounded-lg border border-orange-200 bg-white px-2 text-[10px] font-semibold text-orange-700 hover:bg-orange-50"
            >
              更新
            </button>
          </div>

          <label className="mt-2 block text-[9px] font-medium text-ink-3">
            基于此线精确偏移
          </label>
          <div className="mt-1 grid grid-cols-[76px_1fr_auto] gap-1.5">
            <select
              value={offsetDirection}
              onChange={event =>
                setOffsetDirection(
                  event.target.value as 'negative' | 'positive'
                )
              }
              className="rounded-lg border border-border bg-white px-1.5 text-[10px]"
            >
              <option value="negative">
                {selectedGuide.axis === 'x' ? '左偏' : '上偏'}
              </option>
              <option value="positive">
                {selectedGuide.axis === 'x' ? '右偏' : '下偏'}
              </option>
            </select>
            <input
              value={offsetCm}
              onChange={event => setOffsetCm(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submitOffset();
              }}
              inputMode="decimal"
              className="min-w-0 rounded-lg border border-border bg-white px-2 py-1.5 text-xs tabular-nums outline-none focus:border-orange-400"
            />
            <button
              type="button"
              onClick={submitOffset}
              className="rounded-lg bg-orange-500 px-2.5 text-[10px] font-semibold text-white hover:bg-orange-600"
            >
              新建
            </button>
          </div>

          <div className="mt-2 border-t border-orange-100 pt-2">
            {!dimensionStartGuide ? (
              <button
                type="button"
                onClick={() => onSetDimensionStart(selectedGuide.id)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-brand-200 bg-white py-1.5 text-[10px] font-semibold text-brand-700 hover:bg-brand-50"
              >
                <Crosshair size={12} />
                从 {selectedGuide.label} 开始测距
              </button>
            ) : canCreateDimension ? (
              <button
                type="button"
                onClick={() =>
                  onCreateDimension(dimensionStartGuide.id, selectedGuide.id)
                }
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 py-1.5 text-[10px] font-semibold text-white hover:bg-brand-700"
              >
                标注 {dimensionStartGuide.label} ↔ {selectedGuide.label}
              </button>
            ) : (
              <div className="flex items-center justify-between gap-2 text-[10px] text-brand-700">
                <span>
                  起点：{dimensionStartGuide.label}
                  {dimensionStartGuide.axis !== selectedGuide.axis
                    ? '（请选择同方向线）'
                    : '（请选择另一条线）'}
                </span>
                <button
                  type="button"
                  onClick={() => onSetDimensionStart(null)}
                  className="font-semibold text-red-600"
                >
                  取消
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {dimensionRows.length > 0 && (
        <div className="mt-4">
          <span className="text-[11px] font-bold text-ink">3. 尺寸标注</span>
          <div className="mt-1.5 space-y-1">
            {dimensionRows.map(dimension => (
              <div
                key={dimension.id}
                className="flex items-center gap-2 rounded-lg border border-border bg-canvas/60 px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 text-[10px] font-medium text-ink-2">
                  {dimension.label}
                </span>
                <span className="text-[10px] font-bold tabular-nums text-brand-700">
                  {dimension.distanceCm === null
                    ? '待设置比例尺'
                    : `${formatCm(dimension.distanceCm)} cm`}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteDimension(dimension.id)}
                  className="text-red-500 hover:text-red-700"
                  aria-label={`删除 ${dimension.label} 标注`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
