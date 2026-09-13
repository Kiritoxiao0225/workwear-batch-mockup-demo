import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import type { BackgroundSpec, Region, TextComponent, ArtworkLayout, PlacementSpec } from '../domain/contracts';
import type { StoredImage } from '../application/runtime-types';
import { missingGlyphs } from './font-coverage';
import { localConfig } from './local-config';
import { saveImage, readImage } from './postgres';
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export async function storePng(bytes: Buffer, name: string, kind: StoredImage['kind'] = 'candidate'): Promise<StoredImage> {
    if (!bytes.length || bytes.length > 40 * 1024 * 1024)
        throw new Error('图片为空或超过 40MB');
    const png = await sharp(bytes, { limitInputPixels: 40000000 }).rotate().png().toBuffer();
    const metadata = await sharp(png).metadata();
    if (!metadata.width || !metadata.height)
        throw new Error('图片像素无效');
    const id = sha256(png), root = localConfig().objects;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${id}.png`), temporary = path.join(root, `${randomUUID()}.pending`);
    await writeFile(temporary, png, { flag: 'wx', mode: 0o600 });
    try {
        await link(temporary, target);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw error;
    }
    finally {
        await unlink(temporary);
    }
    if (sha256(await readFile(target)) !== id)
        throw new Error('对象写入读回 SHA 不一致');
    const image: StoredImage = { id, sha256: id, bytes: png.length, width: metadata.width, height: metadata.height, name, kind };
    await saveImage(image);
    return image;
}
export async function imageBytes(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !await readImage(id))
        throw new Error('图片不存在');
    const bytes = await readFile(path.join(localConfig().objects, `${id}.png`));
    if (sha256(bytes) !== id)
        throw new Error('图片内容与文件身份不一致');
    return bytes;
}
export async function crop(bytes: Buffer, region: Region) {
    const m = await sharp(bytes).metadata();
    if (!m.width || !m.height || !Object.values(region).every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > 1 || region.y + region.height > 1)
        throw new Error('选区超出原图');
    const left = Math.floor(region.x * m.width), top = Math.floor(region.y * m.height);
    return sharp(bytes).extract({ left, top, width: Math.min(m.width - left, Math.max(1, Math.round(region.width * m.width))), height: Math.min(m.height - top, Math.max(1, Math.round(region.height * m.height))) }).png().toBuffer();
}
let fontLoaded = false;
function loadFont() {
    if (!fontLoaded) {
        if (!GlobalFonts.registerFromPath(path.join(localConfig().projectRoot, 'public/fonts/DOUYINSANSBOLD.TTF'), 'BatchWorkwear'))
            throw new Error('实际字体文件不可用');
        fontLoaded = true;
    }
}
export async function renderText(component: TextComponent): Promise<Buffer> {
    if (component.content.kind !== 'exact')
        throw new Error('保留原字形必须使用对应图片，不能凭转录重写');
    if (component.font.strategy !== 'available-font' || component.font.referenceUseIds.length && component.font.fallbackPolicy === 'require-match')
        throw new Error('字体参考制作尚未接通，不能用默认字体冒充');
    const text = component.content.value;
    if (!text.trim() || text.length > 500 || /[\u0000-\u0008\u000B-\u001F]/u.test(text))
        throw new Error('文字内容无效');
    if (![component.font.primaryFontAssetId, ...component.font.fallbackFontAssetIds].includes('douyin-sans'))
        throw new Error('本地未提供要求的字体或后备字体');
    const missing = missingGlyphs(await readFile(path.join(localConfig().projectRoot, 'public/fonts/DOUYINSANSBOLD.TTF')), text);
    if (missing.length)
        throw new Error(`实际字体缺少字符：${missing.join('')}；不能静默替换字形`);
    loadFont();
    const canvas = createCanvas(1800, 1000), ctx = canvas.getContext('2d');
    const color = component.color.kind === 'solid' ? component.color.rgba : null;
    if (!color)
        throw new Error('本地排字需要明确颜色，未接通的取色不能用猜测代替');
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${color[3]})`;
    ctx.font = '100px BatchWorkwear';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n');
    const max = Math.max(...lines.map(line => ctx.measureText(line).width));
    const size = Math.min(150, 1640 / Math.max(max, 1) * 100, 800 / Math.max(lines.length, 1) / 1.35);
    ctx.font = `${size}px BatchWorkwear`;
    if (component.layout.kind === 'arc') {
        if (lines.length !== 1)
            throw new Error('弧形文字组件必须为单行');
        const chars = [...text], arc = (component.layout.degrees ?? 70) * Math.PI / 180;
        const widths = chars.map(char => ctx.measureText(char).width), total = widths.reduce((a, b) => a + b, 0);
        const radius = Math.max(250, total / arc), direction = component.layout.direction === 'up' ? 1 : -1;
        let offset = -total / 2;
        chars.forEach((char, i) => {
            const angle = (offset + widths[i] / 2) / radius;
            ctx.save();
            ctx.translate(900 + Math.sin(angle) * radius, 400 + direction * (1 - Math.cos(angle)) * radius);
            ctx.rotate(direction * angle);
            ctx.textAlign = 'center';
            ctx.fillText(char, 0, 0);
            ctx.restore();
            offset += widths[i];
        });
    }
    else {
        ctx.textAlign = component.layout.align;
        const x = component.layout.align === 'center' ? 900 : component.layout.align === 'left' ? 80 : 1720;
        lines.forEach((line, i) => ctx.fillText(line, x, 500 + (i - (lines.length - 1) / 2) * size * 1.35));
    }
    return sharp(canvas.toBuffer('image/png')).trim({ background: '#00000000', threshold: 0 }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#00000000' }).png().toBuffer();
}
/** Offline-only, conservative border flood fill; it is not a replacement for a provider's semantic mask. */
export async function removeExterior(bytes: Buffer, policy: BackgroundSpec): Promise<Buffer> {
    if (policy.exterior !== 'transparent')
        return bytes;
    if (policy.removeRegions.length || policy.preserveRegions.length)
        throw new Error('区域保护抠图还未接入，不能忽略保护规则');
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info, total = w * h;
    if (total > 8000000)
        throw new Error('本地去外底限制 800 万像素');
    const perimeter: number[] = [];
    for (let x = 0; x < w; x++) {
        perimeter.push(x, (h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
        perimeter.push(y * w, y * w + w - 1);
    }
    if (perimeter.filter(p => data[p * 4 + 3] === 0).length / perimeter.length > 0.98)
        return bytes;
    const opaque = perimeter.filter(p => data[p * 4 + 3] > 240), bins = new Map<string, number[]>();
    if (!opaque.length)
        throw new Error('外底的透明边缘尚未确定');
    for (const p of opaque) {
        const key = [0, 1, 2].map(c => Math.floor(data[p * 4 + c] / 16)).join(':');
        const bin = bins.get(key) ?? [];
        bin.push(p);
        bins.set(key, bin);
    }
    const dominant = [...bins.values()].sort((a, b) => b.length - a.length)[0];
    const bg = [0, 1, 2].map(c => dominant.reduce((sum, p) => sum + data[p * 4 + c], 0) / dominant.length);
    function hsv(rgb: number[]) { const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min; let hue = 0; if (delta) {
        if (max === rgb[0])
            hue = (rgb[1] - rgb[2]) / delta;
        else if (max === rgb[1])
            hue = (rgb[2] - rgb[0]) / delta + 2;
        else
            hue = (rgb[0] - rgb[1]) / delta + 4;
        hue = (hue * 60 + 360) % 360;
    } return { hue, saturation: max ? delta / max : 0, value: max }; }
    const background = hsv(bg);
    function isBackground(p: number) {
        if (data[p * 4 + 3] === 0)
            return true;
        const rgb = [0, 1, 2].map(c => data[p * 4 + c]);
        if (rgb.every((v, c) => Math.abs(v - bg[c]) <= 28))
            return true;
        // Only darker edge shadows of the same strongly saturated hue are tolerated.
        // Light/neutral outlines and different-color artwork remain protected.
        const color = hsv(rgb), difference = Math.abs(color.hue - background.hue), hueDistance = Math.min(difference, 360 - difference);
        return background.saturation > .7 && color.saturation > .65 && hueDistance < 14 && color.value >= background.value * .3 && color.value <= background.value;
    }
    if (opaque.filter(isBackground).length / opaque.length < .8)
        throw new Error('外底不一致，无法安全使用本地去底');
    const queue = new Int32Array(total), visited = new Uint8Array(total);
    let head = 0, tail = 0;
    const add = (p: number) => { if (visited[p])
        return; visited[p] = 1; if (isBackground(p))
        queue[tail++] = p; };
    for (let x = 0; x < w; x++) {
        add(x);
        add((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        add(y * w);
        add(y * w + w - 1);
    }
    while (head < tail) {
        const p = queue[head++], x = p % w, y = Math.floor(p / w);
        data[p * 4 + 3] = 0;
        if (x)
            add(p - 1);
        if (x < w - 1)
            add(p + 1);
        if (y)
            add(p - w);
        if (y < h - 1)
            add(p + w);
    }
    if (tail === 0 || tail / total > 0.98)
        throw new Error('去底结果为空或未找到外底，候选不能冒充合格图稿');
    return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
export async function combine(components: Array<{
    id: string;
    bytes: Buffer;
}>, layout: ArtworkLayout) {
    if (!components.length)
        throw new Error('缺少图稿组件');
    if (components.length === 1)
        return components[0].bytes;
    const ordered = layout.componentOrder.map(id => components.find(c => c.id === id));
    if (ordered.some(c => !c) || ordered.length !== components.length)
        throw new Error('图层与排版引用不一致');
    if (layout.kind === 'positioned') {
        const layers = [];
        for (const c of ordered) {
            const p = layout.placements.find(p => p.componentId === c!.id);
            if (!p || p.rotation !== 0)
                throw new Error('该手动排版暂未支持，不能忽略坐标');
            const bytes = await sharp(c!.bytes).resize({ width: Math.round(p.bounds.width * 1600), height: Math.round(p.bounds.height * 1600), fit: 'contain', background: '#00000000' }).png().toBuffer();
            layers.push({ input: bytes, left: Math.round(p.bounds.x * 1600), top: Math.round(p.bounds.y * 1600) });
        }
        return sharp({ create: { width: 1600, height: 1600, channels: 4, background: '#00000000' } }).composite(layers).png().toBuffer();
    }
    if (layout.kind === 'preserve')
        throw new Error('原图排版需有明确合成坐标，不能自动改成纵向排列');
    const horizontal = layout.kind === 'row', normalized = [];
    let extent = 40;
    const gap = Math.round(1200 * (layout.gapRatio ?? 0.06));
    for (const c of ordered) {
        const bytes = await sharp(c!.bytes).trim({ background: '#00000000', threshold: 0 }).resize(horizontal ? { height: 600, width: 1200, fit: 'inside' } : { width: 1200, height: 1200, fit: 'inside' }).png().toBuffer();
        const m = await sharp(bytes).metadata();
        normalized.push({ bytes, width: m.width!, height: m.height! });
        extent += (horizontal ? m.width! : m.height!) + gap;
    }
    let offset = 20;
    const width = horizontal ? extent - gap : 1240, height = horizontal ? 640 : extent - gap;
    const layers = normalized.map(c => { const layer = { input: c.bytes, left: horizontal ? offset : Math.round((width - c.width) / 2), top: horizontal ? Math.round((height - c.height) / 2) : offset }; offset += (horizontal ? c.width : c.height) + gap; return layer; });
    return sharp({ create: { width, height, channels: 4, background: '#00000000' } }).composite(layers).png().toBuffer();
}
export async function composeGarment(base: Buffer, artwork: Buffer, placement: PlacementSpec) {
    if (!placement.center || !placement.bodyWidthCm || !placement.size?.widthCm || placement.rotation !== 0 || placement.face !== 'front' || placement.standardId !== 'local-demo-scale')
        throw new Error('此上衣位置尚未获得本地合成支持，不能忽略尺寸、面或旋转');
    if (placement.baseAssetSha256 !== sha256(base))
        throw new Error('上衣底图与固定版本不一致');
    const garment = await sharp(base).flatten({ background: '#f1f4f7' }).resize({ width: 1000, height: 1100, fit: 'contain', background: '#f1f4f7' }).png().toBuffer();
    // Manually annotated local-demo-scale: cropped front, mid-torso span 57% of the 1000px canvas.
    // Physical 55cm is a fixture value; production must supply catalog calibration.
    const width = Math.max(1, Math.round(placement.size.widthCm / placement.bodyWidthCm * 570));
    const mark = await sharp(artwork).trim({ background: '#00000000', threshold: 0 }).resize({ width }).png().toBuffer(), m = await sharp(mark).metadata();
    const left = Math.round(placement.center.x * 1000 - width / 2), top = Math.round(placement.center.y * 1100 - m.height! / 2);
    if (left < 0 || top < 0 || left + width > 1000 || top + m.height! > 1100)
        throw new Error('图稿超出底图范围');
    return sharp(garment).composite([{ input: mark, left, top }]).png().toBuffer();
}
