import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { atomicFile, hash } from '../adapters/a-files.mjs';
import { assetResponse, previewPath, PREVIEW_EDGE } from '../runtime/asset-response.mjs';

// Pages showed every result at full size with no-store; a 4K PNG is about 10 MB per view.
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'asset-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await sharp({ create: { width: 2731, height: 4096, channels: 4, background: '#e64a1980' } }).png().toBuffer();
  const path = 'production-results/job-1/final-4096.png';
  await atomicFile(resolve(root, 'public', path), original);
  return { root, path, original };
}

test('结果原图：原样返回，带 ETag 和私有缓存', async t => {
  const { root, path, original } = await fixture(t);
  const r = await assetResponse(root, path);
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/png');
  assert.equal(r.headers.ETag, `"${hash(original)}"`);
  assert.match(r.headers['Cache-Control'], /^private, max-age=\d+$/);
  assert.ok(r.bytes.equals(original));
});

test('页面预览：第一次生成 1600px WebP 并保存，第二次直接读保存的那张', async t => {
  const { root, path, original } = await fixture(t);
  const first = await assetResponse(root, path, { preview: true });
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/webp');
  const m = await sharp(first.bytes).metadata();
  assert.equal(Math.max(m.width, m.height), PREVIEW_EDGE);
  assert.equal(m.hasAlpha, true, '透明图预览仍然透明');
  assert.ok(first.bytes.length < original.length / 5, `预览 ${first.bytes.length} B 远小于原图 ${original.length} B`);
  const kept = await readFile(resolve(root, 'public', previewPath(path)));
  assert.ok(kept.equals(first.bytes));
  const second = await assetResponse(root, path, { preview: true });
  assert.ok(second.bytes.equals(kept));
  assert.equal(second.headers.ETag, first.headers.ETag);
  assert.notEqual(first.headers.ETag, `"${hash(original)}"`, '预览和原图的 ETag 不同');
});

test('浏览器带着 ETag 再来：304，不读图片', async t => {
  const { root, path } = await fixture(t);
  const { headers } = await assetResponse(root, path);
  const again = await assetResponse(root, path, { ifNoneMatch: headers.ETag });
  assert.equal(again.status, 304);
  assert.equal(again.bytes, undefined);
  const preview = await assetResponse(root, path, { preview: true });
  assert.equal((await assetResponse(root, path, { preview: true, ifNoneMatch: preview.headers.ETag })).status, 304);
  assert.equal((await assetResponse(root, path, { preview: true, ifNoneMatch: headers.ETag })).status, 200, '原图的 ETag 不能拿来命中预览');
});

test('不存在的图片：404，不生成预览', async t => {
  const { root } = await fixture(t);
  assert.equal((await assetResponse(root, 'production-results/none/final.png', { preview: true })).status, 404);
  await assert.rejects(stat(resolve(root, 'public', previewPath('production-results/none/final.png'))));
});
