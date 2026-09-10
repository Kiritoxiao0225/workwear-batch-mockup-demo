import { artworkTextGlyphLayout, type ArtworkTextLayer } from './artwork-editor';
export function artworkTextFont(text: ArtworkTextLayer) {
  return `${text.italic ? 'italic ' : ''}${text.fontWeight} ${text.fontSize}px ${text.fontFamily}`;
}
export function measureArtworkText(text: ArtworkTextLayer, context: Pick<CanvasRenderingContext2D, 'font' | 'textAlign' | 'textBaseline' | 'measureText'>) {
  context.font = artworkTextFont(text);
  context.textAlign = 'center'; context.textBaseline = 'middle';
  const displayText = text.value.replace(/\r\n?/gu, '\n').replace(/\n/gu, text.arc.mode === 'none' ? '' : ' ');
  const metrics = [...displayText].map(char => context.measureText(char));
  const glyphs = artworkTextGlyphLayout(text, metrics.map(metric => metric.width));
  const alignmentOffset = 0; // Per-line alignment is already included in each glyph.
  const points: { x: number; y: number }[] = [];
  const letters: { char: string; height: number }[] = [];
  glyphs.forEach((glyph, index) => {
    if (!glyph.char.trim()) return;
    const metric = metrics[index];
    const x0 = -metric.actualBoundingBoxLeft, x1 = metric.actualBoundingBoxRight;
    const y0 = -metric.actualBoundingBoxAscent;
    const y1 = text.underline ? Math.max(metric.actualBoundingBoxDescent, text.fontSize * .58 + Math.max(1.5, text.fontSize / 24) / 2) : metric.actualBoundingBoxDescent;
    const radians = glyph.rotation * Math.PI / 180;
    for (const x of [x0, x1]) for (const y of [y0, y1]) points.push({ x: text.x + alignmentOffset + glyph.x + x * Math.cos(radians) - y * Math.sin(radians), y: text.y + glyph.y + x * Math.sin(radians) + y * Math.cos(radians) });
    if (/[\p{L}\p{N}]/u.test(glyph.char)) letters.push({ char: glyph.char, height: metric.actualBoundingBoxAscent + metric.actualBoundingBoxDescent });
  });
  const left = points.length ? Math.min(...points.map(point => point.x)) : text.x;
  const top = points.length ? Math.min(...points.map(point => point.y)) : text.y;
  const right = points.length ? Math.max(...points.map(point => point.x)) : left + 1;
  const bottom = points.length ? Math.max(...points.map(point => point.y)) : top + 1;
  return { glyphs, alignmentOffset, bounds: { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }, letters };
}
