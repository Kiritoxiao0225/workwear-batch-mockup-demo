import { describe, expect, it } from 'vitest';
import { calibrationStatus } from './catalog-calibration-status';

describe('visible calibration status', () => {
  it('does not call an untouched or partly confirmed color ready', () => {
    expect(calibrationStatus({ faceCount: 2, confirmedFaces: 0, hasDraft: false }).label).toBe('未校准');
    expect(calibrationStatus({ faceCount: 2, confirmedFaces: 1, hasDraft: false }).label).toBe('部分已确认');
    expect(calibrationStatus({ faceCount: 1, confirmedFaces: 1, hasDraft: false }).label).toBe('已确认');
    expect(calibrationStatus({ faceCount: 0, confirmedFaces: 0, hasDraft: false }).label).toBe('未校准');
  });
  it('shows the new draft even when both faces have an older confirmation', () => {
    expect(calibrationStatus({ faceCount: 2, confirmedFaces: 2, hasDraft: true }).label).toBe('草稿待确认');
  });
});
