export const DEFAULT_ARTWORK_FONT = 'Douyin Sans, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif';
export const ARTWORK_TEXT_COLORS = ['#000000', '#ffffff', '#ff0000'] as const;

/** Greatest RGB color distance among the three requested inks; ties keep palette order. */
export function contrastingArtworkTextColor(garment: readonly [number, number, number]) {
  const distance = (color: string) => [1, 3, 5].reduce((sum, start, index) =>
    sum + (parseInt(color.slice(start, start + 2), 16) - garment[index]) ** 2, 0);
  return ARTWORK_TEXT_COLORS.reduce((best, color) => distance(color) > distance(best) ? color : best);
}
