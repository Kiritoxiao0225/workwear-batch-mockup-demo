/** Real cutout lifecycle + real isolated JSON files. Providers are explicitly
 * injected deterministic fakes; no database, object store, network or model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ARTWORK_CUTOUT_VERSION } from '@/lib/artwork-cutout';
import { artworkProtectionPolicy } from '@/lib/artwork-protection';
import { startArtworkCutout, queryArtworkCutout, type CutoutServices } from './artwork-cutout';
import { claimCutoutJob, readCutoutJob, type StoredCutout } from './artwork-cutout-store';
import { MEITU_CUTOUT_VERSION } from './meitu-cutout';
import { productionStateKey } from './production-storage';
import { ARTWORK_INTEGRITY_VERSION } from './artwork-foreground-integrity';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const inline = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
const decode = (s: string) => Buffer.from(s.split(',')[1], 'base64');
const fixture = (name: string) => readFile(path.join(process.cwd(), 'lib/server/artwork-task-a-fixtures', name));
const normalize = (b: Buffer) => sharp(b).rotate().png().toBuffer();
const svg = (alpha = false) => sharp(Buffer.from(`<svg width="400" height="300">${alpha ? '' : '<rect width="400" height="300" fill="white"/>'}<path d="M90 60h220v180H90z M130 100v100h140V100z" fill="black" fill-rule="evenodd"/></svg>`)).png().toBuffer();
function fakes(output: Buffer) {
  const calls = { volcano: 0, submit: 0, upload: 0, inspection: 0, download: 0 };
  const services: CutoutServices = {
    upload: async () => { calls.upload++; return 'https://fixture.invalid/input'; },
    submit: async () => { calls.submit++; return { code: 0, data: { task_id: 'fixture-task' } }; },
    query: async () => ({ code: 0, data: { status: 10, result: { media_info_list: [{ media_data: 'https://fixture.invalid/result' }] } } }),
    download: async () => { calls.download++; return Buffer.from(output); }, credits: async () => 1,
    volcano: async (_bytes, options) => { calls.volcano++; await options?.beforeSubmit?.(); return 'https://fixture.invalid/result'; },
    volcanoDownload: async () => { calls.download++; return Buffer.from(output); },
    inspectWatermarks: async () => { calls.inspection++; return []; },
  };
  return { services, calls };
}
async function isolated(task: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'task-a-cutout-'));
  const env = { WPS_PRODUCTION_STORAGE: 'local', ARTWORK_CUTOUT_CACHE_DIR: directory, ARTWORK_CUTOUT_FILE_STORAGE: 'inline', MEITU_OPENAPI_ACCESS_KEY: 'offline-fixture', MEDIAKIT_API_KEY: 'offline-fixture' };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { await task(directory); } finally {
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
}
async function legacy(source: Buffer, output: Buffer, badge = false): Promise<StoredCutout> {
  source = await normalize(source);
  const sourceSha256 = sha(source);
  const key = sha(JSON.stringify([productionStateKey(), sha(process.env.MEITU_OPENAPI_ACCESS_KEY!), sha(process.env.MEDIAKIT_API_KEY!), MEITU_CUTOUT_VERSION, ARTWORK_CUTOUT_VERSION, 'standard', sourceSha256, '']));
  const job: StoredCutout = { status: 'completed', phase: 'finished', requestId: 'historical-provider-submission', updatedAt: '2026-09-11T00:00:00Z', url: inline(output), receipt: {
    jobKey: key, mode: 'standard', sourceSha256, sourceUrl: inline(source), outputSha256: sha(output), route: 'volcano', reasons: ['historical result'], version: ARTWORK_CUTOUT_VERSION,
    estimatedCredits: null, actualCredits: null, cacheHit: false,
    ...(badge ? { badgeProtection: { regions: 1, restoredPixels: 123 } } : {}),
  } };
  assert.equal(await claimCutoutJob(job), true); return job;
}
export const taskALifecycleCases: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'P provider loss persists source/raw/candidate/missing bounds and repeat performs no new submission', run: () => isolated(async () => {
    const source = await fixture('P-cutout-input.png'), output = await fixture('P-after-cutout.png'), { services, calls } = fakes(output);
    const result = await startArtworkCutout(source, 'standard', { services });
    assert.equal(result.status, 'failed'); assert.equal(result.receipt.diagnostics?.stage, 'completeness');
    assert.equal(result.receipt.providerOutputUrl, inline(output)); assert.ok(result.candidate?.missingRegions.some(r => r.left === 0 && r.width >= 530));
    const saved = await readCutoutJob(result.receipt.jobKey);
    assert.deepEqual(saved?.candidate, result.candidate); assert.equal(saved?.receipt.sourceUrl, inline(await normalize(source)));
    assert.deepEqual((await queryArtworkCutout(result.receipt.jobKey, services)).candidate, result.candidate);
    await startArtworkCutout(source, 'standard', { services });
    assert.equal(calls.volcano, 1); assert.equal(calls.submit, 0);
  }) },
  { name: 'legacy passed P is locally rejected without mutating its original record or repurchasing', run: () => isolated(async directory => {
    const source = await fixture('P-cutout-input.png'), output = await fixture('P-after-cutout.png'), old = await legacy(source, output), { services, calls } = fakes(output);
    const filename = path.join(directory, `${old.receipt.jobKey}.json`), before = await readFile(filename);
    const result = await startArtworkCutout(source, 'standard', { services });
    assert.equal(result.status, 'failed'); assert.ok(result.candidate?.missingRegions.some(r => r.left === 0));
    assert.equal(result.receipt.localValidationOnly, true); assert.equal(result.receipt.reusedFrom, old.receipt.jobKey);
    assert.notEqual(result.receipt.jobKey, old.receipt.jobKey); assert.deepEqual(await readFile(filename), before);
    assert.equal(calls.volcano + calls.submit + calls.upload + calls.inspection + calls.download, 0);
  }) },
  { name: 'unknown paid submission remains unknown after policy change; never retries', run: () => isolated(async () => {
    const source = await svg(), { services, calls } = fakes(await svg(true));
    services.volcano = async (_bytes, options) => { calls.volcano++; await options?.beforeSubmit?.(); throw new Error('fixture: lost submission response'); };
    const first = await startArtworkCutout(source, 'standard', { services });
    assert.equal(first.status, 'unknown');
    const second = await startArtworkCutout(source, 'standard', { services, protection: artworkProtectionPolicy('全部背景去除，圆内也透明') });
    assert.equal(second.status, 'unknown'); assert.equal(second.receipt.reusedFrom, first.receipt.jobKey);
    await queryArtworkCutout(second.receipt.jobKey, services);
    await assert.rejects(startArtworkCutout(source, 'standard', { services, retryOf: first.receipt.jobKey }), /只有已明确失败/);
    assert.equal(calls.volcano, 1); assert.equal(calls.submit, 0);
  }) },
  { name: 'concurrent different background policies share exactly one supplier submission and retain distinct local scopes', run: () => isolated(async () => {
    const source = await svg(), { services, calls } = fakes(await svg(true));
    const policies = [artworkProtectionPolicy('仅去除外围背景，保留内部底色'), artworkProtectionPolicy('全部背景去除，圆内也透明')];
    const results = await Promise.all(policies.map(protection => startArtworkCutout(source, 'standard', { services, protection })));
    for (let i = 0; i < results.length; i++) {
      const result = await queryArtworkCutout(results[i].receipt.jobKey, services);
      assert.equal(result.status, 'completed'); assert.deepEqual(result.receipt.protection?.background, policies[i].background);
    }
    assert.equal(calls.volcano, 1); assert.equal(calls.submit, 0);
  }) },
  { name: 'fuzzy supplier mask is diagnosed and original full-bleed red panel pixels restore without square corners', run: () => isolated(async () => {
    const w = 300, h = 180, r = 24, source = Buffer.alloc(w * h * 4, 255), candidate = Buffer.alloc(source.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x < r ? r - .5 - x : x >= w - r ? x - (w - r - .5) : 0, dy = y < r ? r - .5 - y : y >= h - r ? y - (h - r - .5) : 0;
      const inside = !dx || !dy || dx * dx + dy * dy <= r * r, letter = x >= 115 && x < 123 && y >= 70 && y < 100, i = (y * w + x) * 4;
      if (inside) { source[i] = letter ? 255 : 220; source[i + 1] = letter ? 255 : 25; source[i + 2] = letter ? 255 : 35; }
      source.copy(candidate, i, i, i + 3); candidate[i + 3] = inside ? 130 : 0;
    }
    const png = (data: Buffer) => sharp(data, { raw: { width: w, height: h, channels: 4 as const } }).png().toBuffer();
    const original = await png(source), output = await png(candidate), { services, calls } = fakes(output);
    let result = await startArtworkCutout(original, 'meitu', { services, protection: artworkProtectionPolicy('保留红色圆角底形和白字') });
    result = await queryArtworkCutout(result.receipt.jobKey, services);
    assert.equal(result.status, 'completed'); assert.ok(result.receipt.diagnostics?.rawMaskError);
    assert.equal(result.receipt.diagnostics?.acceptance, 'explicit-full-bleed-panel'); assert.equal(result.receipt.integrityCheck?.status, 'checked');
    assert.equal(result.receipt.providerOutputUrl, inline(output));
    const actual = await sharp(decode(result.url!)).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < actual.length; i += 4) if (candidate[i + 3]) assert.deepEqual(actual.subarray(i, i + 4), source.subarray(i, i + 4)); else assert.equal(actual[i + 3], 0);
    assert.equal(calls.submit, 1);
  }) },
  { name: 'unprotected all-soft mask fails at final-mask, retains supplier bytes, never reports completed', run: () => isolated(async () => {
    const source = await svg(), raw = await sharp(await svg(true)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < raw.data.length; i += 4) if (raw.data[i]) raw.data[i] = 130;
    const output = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } }).png().toBuffer();
    const { services, calls } = fakes(output), result = await startArtworkCutout(source, 'standard', { services });
    assert.equal(result.status, 'failed'); assert.equal(result.receipt.diagnostics?.stage, 'final-mask'); assert.ok(result.receipt.diagnostics.rawMaskError);
    assert.equal(result.receipt.providerOutputUrl, inline(output)); assert.equal(result.candidate?.url, inline(output)); assert.equal(result.url, undefined);
    assert.equal(calls.volcano, 1);
  }) },
  { name: 'historical badge result without raw provider mask cannot certify a new all-background contract', run: () => isolated(async directory => {
    const source = await svg(), output = await svg(true), old = await legacy(source, output, true), { services, calls } = fakes(output);
    const filename = path.join(directory, `${old.receipt.jobKey}.json`), before = await readFile(filename);
    const result = await startArtworkCutout(source, 'standard', { services, protection: artworkProtectionPolicy('全部背景去除，圆内也透明') });
    assert.equal(result.status, 'failed'); assert.match(result.error!, /缺少供应商原始遮罩/); assert.equal(result.candidate?.url, inline(output));
    assert.deepEqual(await readFile(filename), before); assert.equal(calls.volcano + calls.submit + calls.download, 0);
  }) },
  { name: 'unsupported source evidence persists uncertainty and a usable candidate instead of fabricating passed', run: () => isolated(async () => {
    const w = 192, h = 144, source = Buffer.alloc(w * h * 4), output = Buffer.alloc(source.length); let seed = 123;
    for (let i = 0; i < source.length; i += 4) { for (let c = 0; c < 3; c++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; source[i + c] = seed >>> 24; } source[i + 3] = 255; }
    for (let y = 45; y < 100; y++) for (let x = 45; x < 140; x++) output[(y * w + x) * 4 + 3] = 255;
    const png = (data: Buffer) => sharp(data, { raw: { width: w, height: h, channels: 4 as const } }).png().toBuffer();
    const candidate = await png(output), { services } = fakes(candidate);
    const result = await startArtworkCutout(await png(source), 'standard', { services });
    assert.equal(result.status, 'completed'); assert.equal(result.receipt.integrityCheck?.status, 'uncertain'); assert.ok(result.receipt.integrityCheck.warning);
    assert.equal(result.candidate?.url, inline(candidate)); assert.equal(result.receipt.localValidationVersion, ARTWORK_INTEGRITY_VERSION);
    assert.equal((await readCutoutJob(result.receipt.jobKey))?.receipt.integrityCheck?.status, 'uncertain');
  }) },
];
