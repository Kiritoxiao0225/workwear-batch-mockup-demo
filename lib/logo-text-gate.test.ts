import { describe, expect, it } from 'vitest';

import { evaluateLogoText, logoTextSimilarity, normalizeLogoText } from '@/lib/logo-text-gate';

const line = (text: string, score: number, left: number, top: number) => ({
  text,
  score,
  poly: [
    { x: left, y: top },
    { x: left + 80, y: top },
    { x: left + 80, y: top + 20 },
    { x: left, y: top + 20 },
  ],
});

describe('Logo text gate', () => {
  it('normalizes width and whitespace without erasing meaningful punctuation', () => {
    expect(normalizeLogoText(' 汉方\n嘉铁永坊店 ')).toBe('汉方嘉铁永坊店');
    expect(normalizeLogoText('ＡＢＣ１２３')).toBe('ABC123');
    expect(normalizeLogoText('侃侃家.红糖藕粉')).not.toBe(normalizeLogoText('侃侃家·红糖藕粉'));
    expect(logoTextSimilarity('汉方嘉铁永坊点', '汉方嘉铁永坊店')).toBeCloseTo(6 / 7);
    expect(logoTextSimilarity('汉方嘉铁永坊点', 'S又方嘉铁永坊店')).toBeLessThan(6 / 7);
  });

  it('passes only when ordered OCR text is exact and sufficiently confident', () => {
    const result = evaluateLogoText('汉方嘉铁永坊店', [
      line('永坊店', 0.94, 120, 60),
      line('汉方嘉铁', 0.91, 20, 60),
    ]);

    expect(result.recognizedText).toBe('汉方嘉铁\n永坊店');
    expect(result.exactText).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('keeps punctuation mismatch and low confidence in needs-review state', () => {
    expect(evaluateLogoText('侃侃家.红糖藕粉', [
      line('侃侃家·红糖藕粉', 0.96, 20, 40),
    ])).toMatchObject({ reason: 'textMismatch', passed: false });

    expect(evaluateLogoText('轻工业店', [
      line('轻工业店', 0.52, 20, 40),
    ])).toMatchObject({ reason: 'lowConfidence', exactText: true, passed: false });
  });

  it('fails fast for empty targets and invalid OCR confidence', () => {
    expect(() => evaluateLogoText('  ', [])).toThrow('目标文字不能为空');
    expect(() => evaluateLogoText('测试', [line('测试', 2, 20, 40)]))
      .toThrow('OCR 文字“测试”的置信度无效：2');
  });
});
