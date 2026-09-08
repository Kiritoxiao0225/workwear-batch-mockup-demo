import sharp from 'sharp';

import { logoTextGuideLines } from '@/lib/logo-text-guide';

const GUIDE_WIDTH = 1536;
const GUIDE_HEIGHT = 768;
const GUIDE_HORIZONTAL_PADDING = 120;

function escapeSvgText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function createLogoTextGuideDataUrl(targetText: string) {
  const [line] = logoTextGuideLines(targetText);
  const characters = Array.from(line);
  const maximumTextWidth = GUIDE_WIDTH - GUIDE_HORIZONTAL_PADDING * 2;
  const fontSize = Math.max(96, Math.min(310, Math.floor(maximumTextWidth / characters.length)));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${GUIDE_WIDTH}" height="${GUIDE_HEIGHT}" viewBox="0 0 ${GUIDE_WIDTH} ${GUIDE_HEIGHT}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text
        x="50%"
        y="50%"
        dominant-baseline="central"
        text-anchor="middle"
        fill="#000000"
        font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"
        font-size="${fontSize}"
        font-weight="700"
      >${escapeSvgText(line)}</text>
    </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}
