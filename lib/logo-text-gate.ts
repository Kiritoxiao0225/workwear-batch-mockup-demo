export const LOGO_OCR_MIN_SCORE = 0.65;

export type LogoOcrTextItem = {
  text: string;
  score: number;
  poly: Array<{ x: number; y: number }>;
};

export type LogoTextGateResult = {
  expectedText: string;
  recognizedText: string;
  normalizedExpectedText: string;
  normalizedRecognizedText: string;
  minimumScore: number;
  exactText: boolean;
  passed: boolean;
  reason: 'passed' | 'noText' | 'textMismatch' | 'lowConfidence';
};

export function normalizeLogoText(text: string) {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

export function logoTextSimilarity(expectedText: string, recognizedText: string) {
  const expected = Array.from(normalizeLogoText(expectedText));
  const recognized = Array.from(normalizeLogoText(recognizedText));
  const longestLength = Math.max(expected.length, recognized.length);
  if (longestLength === 0) return 1;

  const distances = Array.from({ length: expected.length + 1 }, (_, row) =>
    Array.from({ length: recognized.length + 1 }, (_, column) => row === 0 ? column : column === 0 ? row : 0),
  );
  for (let row = 1; row <= expected.length; row += 1) {
    for (let column = 1; column <= recognized.length; column += 1) {
      const replacementCost = expected[row - 1] === recognized[column - 1] ? 0 : 1;
      distances[row][column] = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + replacementCost,
      );
    }
  }
  return 1 - distances[expected.length][recognized.length] / longestLength;
}

function itemBounds(item: LogoOcrTextItem) {
  if (!Array.isArray(item.poly) || item.poly.length < 3) {
    throw new Error(`OCR 文字“${item.text}”缺少有效坐标`);
  }
  const xs = item.poly.map((point) => point.x);
  const ys = item.poly.map((point) => point.y);
  if (![...xs, ...ys].every(Number.isFinite)) {
    throw new Error(`OCR 文字“${item.text}”包含无效坐标`);
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, top, centerY: (top + bottom) / 2, height: bottom - top };
}

function readingOrder(items: LogoOcrTextItem[]) {
  return [...items].sort((leftItem, rightItem) => {
    const left = itemBounds(leftItem);
    const right = itemBounds(rightItem);
    const sameLine = Math.abs(left.centerY - right.centerY) <= Math.max(left.height, right.height) * 0.5;
    return sameLine ? left.left - right.left : left.top - right.top;
  });
}

export function evaluateLogoText(
  expectedText: string,
  rawItems: LogoOcrTextItem[],
): LogoTextGateResult {
  const normalizedExpectedText = normalizeLogoText(expectedText);
  if (!normalizedExpectedText) {
    throw new Error('目标文字不能为空');
  }

  const items = rawItems.filter((item) => normalizeLogoText(item.text).length > 0);
  for (const item of items) {
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
      throw new Error(`OCR 文字“${item.text}”的置信度无效：${String(item.score)}`);
    }
  }

  const orderedItems = readingOrder(items);
  const recognizedText = orderedItems.map((item) => item.text.trim()).join('\n');
  const normalizedRecognizedText = normalizeLogoText(recognizedText);
  const minimumScore = orderedItems.length > 0
    ? Math.min(...orderedItems.map((item) => item.score))
    : 0;
  const exactText = normalizedExpectedText === normalizedRecognizedText;
  const reason = orderedItems.length === 0
    ? 'noText'
    : !exactText
      ? 'textMismatch'
      : minimumScore < LOGO_OCR_MIN_SCORE
        ? 'lowConfidence'
        : 'passed';

  return {
    expectedText,
    recognizedText,
    normalizedExpectedText,
    normalizedRecognizedText,
    minimumScore,
    exactText,
    passed: reason === 'passed',
    reason,
  };
}
