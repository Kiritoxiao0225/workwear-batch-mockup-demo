export type ArtworkPreviewTone = 'light' | 'dark' | 'gray';

/** Only visible pixels count; transparent padding often contains arbitrary RGB. */
export function artworkPreviewTone(pixels: ArrayLike<number>): ArtworkPreviewTone {
  let weight = 0, brightness = 0, light = 0, dark = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    if (alpha < .03) continue;
    const value = (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722) / 255;
    weight += alpha;
    brightness += value * alpha;
    if (value > .7) light += alpha;
    if (value < .3) dark += alpha;
  }
  if (!weight || (light / weight >= .1 && dark / weight >= .1)) return 'gray';
  return brightness / weight >= .6 ? 'dark' : 'light';
}
