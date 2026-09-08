import sharp from 'sharp';

type VerticalBand = { top: number; bottom: number };

export function splitVerticalContentBands(occupiedRows: boolean[], maximumGap: number) {
  const occupiedIndexes = occupiedRows
    .map((occupied, index) => occupied ? index : -1)
    .filter((index) => index >= 0);
  if (occupiedIndexes.length === 0) throw new Error('客户图片中没有可提取的非白色内容');

  const bands: VerticalBand[] = [];
  let top = occupiedIndexes[0];
  let previous = top;
  for (const row of occupiedIndexes.slice(1)) {
    if (row - previous > maximumGap) {
      bands.push({ top, bottom: previous });
      top = row;
    }
    previous = row;
  }
  bands.push({ top, bottom: previous });
  return bands;
}

export function chooseRequestedBand(
  bands: VerticalBand[],
  keepDescription: string,
  imageHeight: number,
) {
  if (bands.length === 0) throw new Error('没有可选择的图形区域');
  if (keepDescription.includes('顶部') || keepDescription.includes('上方')) return bands[0];
  if (keepDescription.includes('底部') || keepDescription.includes('下方')) return bands[bands.length - 1];
  if (keepDescription.includes('中间') || keepDescription.includes('中央')) {
    return [...bands].sort((left, right) => {
      const leftDistance = Math.abs((left.top + left.bottom) / 2 - imageHeight / 2);
      const rightDistance = Math.abs((right.top + right.bottom) / 2 - imageHeight / 2);
      return leftDistance - rightDistance;
    })[0];
  }
  return [...bands].sort(
    (left, right) => (right.bottom - right.top) - (left.bottom - left.top),
  )[0];
}

function imageBuffer(dataUrl: string) {
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('图片 Data URL 缺少 Base64 内容');
  return Buffer.from(dataUrl.slice(separator + 1), 'base64');
}

function isContentPixel(red: number, green: number, blue: number, alpha: number) {
  if (alpha <= 20) return false;
  const brightest = Math.max(red, green, blue);
  const darkest = Math.min(red, green, blue);
  return !(brightest >= 232 && brightest - darkest <= 32);
}

async function makeWhiteTransparent(buffer: Buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 4) {
    if (!isContentPixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
      data[offset + 3] = 0;
    }
  }
  return sharp(data, { raw: info })
    .png()
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
}

export function removeWhiteLogoBackground(buffer: Buffer) {
  return makeWhiteTransparent(buffer);
}

export async function extractRequestedGraphic(
  sourceDataUrl: string,
  keepDescription: string,
) {
  const source = imageBuffer(sourceDataUrl);
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const occupiedRows = Array.from({ length: info.height }, () => false);
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      if (isContentPixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
        occupiedRows[y] = true;
        break;
      }
    }
  }

  const bands = splitVerticalContentBands(
    occupiedRows,
    Math.max(2, Math.round(info.height * 0.02)),
  );
  const band = chooseRequestedBand(bands, keepDescription, info.height);
  let left = info.width;
  let right = -1;
  for (let y = band.top; y <= band.bottom; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      if (isContentPixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  if (right < left) throw new Error('选中的图形区域没有有效像素');
  const paddingX = Math.max(2, Math.round(info.width * 0.02));
  const paddingY = Math.max(2, Math.round(info.height * 0.02));
  const cropLeft = Math.max(0, left - paddingX);
  const cropTop = Math.max(0, band.top - paddingY);
  const cropRight = Math.min(info.width - 1, right + paddingX);
  const cropBottom = Math.min(info.height - 1, band.bottom + paddingY);
  const cropped = await sharp(source).extract({
    left: cropLeft,
    top: cropTop,
    width: cropRight - cropLeft + 1,
    height: cropBottom - cropTop + 1,
  }).png().toBuffer();
  return makeWhiteTransparent(cropped);
}

async function containLayer(buffer: Buffer, maximumWidth: number, maximumHeight: number) {
  const resized = await sharp(buffer)
    .resize({ width: maximumWidth, height: maximumHeight, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  if (!metadata.width || !metadata.height) throw new Error('合成图层缺少尺寸');
  return { buffer: resized, width: metadata.width, height: metadata.height };
}

export async function composeCompleteLogo(graphicBuffer: Buffer, textLayerBuffer: Buffer) {
  const graphic = await containLayer(await makeWhiteTransparent(graphicBuffer), 920, 900);
  const text = await containLayer(await makeWhiteTransparent(textLayerBuffer), 1450, 430);
  const gap = 120;
  const contentHeight = graphic.height + gap + text.height;
  const graphicTop = Math.round((2048 - contentHeight) / 2);
  const textTop = graphicTop + graphic.height + gap;
  return sharp({
    create: {
      width: 2048,
      height: 2048,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    },
  }).composite([
    { input: graphic.buffer, left: Math.round((2048 - graphic.width) / 2), top: graphicTop },
    { input: text.buffer, left: Math.round((2048 - text.width) / 2), top: textTop },
  ]).png().toBuffer();
}
