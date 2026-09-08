// Project readability reminders, not a manufacturing acceptance standard.
export function printedTextHeights(letters: { char: string; height: number }[], artworkHeightPx: number, printedHeightCm: number) {
  if (![artworkHeightPx, printedHeightCm].every(value => Number.isFinite(value) && value > 0)) throw new Error(`文字尺寸换算无效：${artworkHeightPx}px / ${printedHeightCm}cm`);
  if (letters.some(letter => !Number.isFinite(letter.height) || letter.height <= 0)) throw new Error('文字可见高度无效');
  return ([{ name: '中文', chinese: true, minimum: .8, recommended: 1 }, { name: '英文 / 数字', chinese: false, minimum: .6, recommended: .65 }]).flatMap(group => {
    const matching = letters.filter(letter => /\p{Script=Han}/u.test(letter.char) === group.chinese);
    if (!matching.length) return [];
    const heightCm = Math.min(...matching.map(letter => letter.height)) / artworkHeightPx * printedHeightCm;
    return [{ ...group, heightCm, small: heightCm < group.minimum }];
  });
}
