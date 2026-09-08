import { CONFIRMATION_FRAME } from '../lib/confirmation-frame';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderConfirmationFrame } from '../lib/server/confirmation-frame';

// A local visual proof only; no customer production state or catalog records are written.
const manifest = JSON.parse(await readFile('output/catalog/garment-import-manifest.json', 'utf8'));
const entry = manifest.entries.find((item: { styleCode: string; colorName: string }) => item.styleCode === '301SRX' && item.colorName === '极致黑');
if (!entry) throw new Error('导入清单中未找到 301SRX / 极致黑');
const garment = await readFile(path.join(manifest.outputDirectory, entry.filename));
if (createHash('sha256').update(garment).digest('hex') !== entry.sha256) throw new Error(`素材与已入库清单不一致：${entry.filename}`);
const frame = await readFile(path.join('public', CONFIRMATION_FRAME.assetPath));
const png = await renderConfirmationFrame(garment, frame, [
  { face: 'front', crop: { x: 0, y: 0, width: 0.5, height: 1 } },
  { face: 'back', crop: { x: 0.5, y: 0, width: 0.5, height: 1 } },
]);
const directory = path.join(process.cwd(), 'output/confirmation-frame-preview');
await mkdir(directory, { recursive: true });
const file = path.join(directory, '301SRX-极致黑-带框试排.png');
await writeFile(file, png);
console.log(file);
