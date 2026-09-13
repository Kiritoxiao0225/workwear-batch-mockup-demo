import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import sharp from 'sharp';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(here, '../../..');
export const outputRoot = resolve(repository, process.env.A_REVIEW_OUTPUT || 'output/a-standardization-36-20260913-originals');
export const sourceRepository = '/Users/xiaofeng/Documents/ChatGPT/批量效果图生成demo';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function jsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function atomicFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, path);
}
export const saveJSON = (path, value) => atomicFile(path, JSON.stringify(value, null, 2) + '\n');

// Parse only; never repair the model's wording, references or meaning.
export function parseResult(content) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('输出不是 JSON 对象');
  if (typeof parsed.standardizedRequirement !== 'string' || !parsed.standardizedRequirement.trim()) throw new Error('缺少完整制作说明');
  if (!Array.isArray(parsed.readingIssues) || parsed.readingIssues.some(x => !x || typeof x.scope !== 'string' || typeof x.issue !== 'string')) throw new Error('readingIssues 格式不正确');
  if (Object.keys(parsed).some(x => !['standardizedRequirement', 'readingIssues'].includes(x))) throw new Error('输出含约定外字段，保留原始返回供检查');
  return parsed;
}
export function structuralObservations(result, imageCount, format = 'four-sections') {
  const notes = [];
  const text = result.standardizedRequirement;
  if (format === 'four-sections') for (const heading of ['整体目标', '素材用途', '图稿要求', '应用关系']) if (!text.includes(heading)) notes.push(`未找到“${heading}”标题`);
  for (const match of text.matchAll(/图\s*([0-9０-９]+)/gu)) {
    const n = Number(match[1].replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 65296)));
    if (n < 1 || n > imageCount) notes.push(`文中出现输入集合外的图号：图${n}`);
  }
  return [...new Set(notes)];
}
export async function publish() {
  const manifest = await jsonFile(resolve(outputRoot, 'manifest.json'));
  const scope = await jsonFile(resolve(outputRoot, 'scope.json'), null);
  const qaNotes = await jsonFile(resolve(outputRoot, 'qa-notes.json'), {});
  const audit = await jsonFile(resolve(outputRoot, 'qa-audit.json'), null);
  const cases = [];
  for (const c of manifest.cases) {
    const r = await jsonFile(resolve(outputRoot, `results/${c.caseId}.json`), { status: 'pending' });
    const images = [];
    for (const img of c.images) {
      const thumbnail = `thumbs/${img.imageId}.webp`, path = resolve(outputRoot, 'public', thumbnail);
      try { await access(path); } catch {
        const preview = await sharp(resolve(outputRoot, 'public', img.asset)).rotate().resize({ width: 640, height: 500, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
        await atomicFile(path, preview);
      }
      images.push({ ...img, thumbnail });
    }
    cases.push({ ...c, images, result: r, scope: scope?.cases[c.caseId] || null, audit: audit?.cases[c.caseId] || null, qaNotes: qaNotes[c.caseId] || [] });
  }
  const data = { run: manifest.run, auditSummary: audit?.summary || null, scope: scope ? { version: scope.version, method: scope.method, rules: scope.rules } : null, cases };
  await saveJSON(resolve(outputRoot, 'public/data.json'), data);
  const template = await readFile(resolve(here, 'review.html'), 'utf8');
  const payload = JSON.stringify(data).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
  await atomicFile(resolve(outputRoot, 'public/index.html'), template.replace('/*__RUN_DATA__*/null', payload));
  await atomicFile(resolve(outputRoot, 'public/prompt.txt'), await readFile(resolve(outputRoot, 'prompt.txt')));
  return data;
}
