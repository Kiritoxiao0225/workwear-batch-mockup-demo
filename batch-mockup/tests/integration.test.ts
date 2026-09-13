import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { initializeLocalDatabase, closeDatabase, db, saveOrder, enqueue, claim, readRun, readSteps, resumeRun, updateRun, compareAndSaveRequirement, readOrder, beginAttempt, saveAttemptReceipt } from '../adapters/postgres';
import { storePng, imageBytes, renderText, removeExterior, sha256, crop } from '../adapters/images';
import { missingGlyphs } from '../adapters/font-coverage';
import { annotatedOrder } from './local-orders';
import { planArtwork } from '../domain/planner';
import { validateRequirement } from '../domain/validation';
import { executeRun } from '../application/execute';
import { getState, postRun, postRequirement } from '../http/handlers';
import type { LocalOrder, StoredImage } from '../application/runtime-types';
let root: string, database: EmbeddedPostgres, image: StoredImage;
const project = process.cwd();
async function freePort() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); if (!addr || typeof addr === 'string')
    throw Error(); const port = addr.port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'batch-mockup-test-'));
    const port = await freePort(), password = randomBytes(24).toString('hex');
    process.env.BATCH_MOCKUP_MODE = 'offline';
    process.env.BATCH_MOCKUP_DATABASE_URL = `postgresql://test:${password}@127.0.0.1:${port}/postgres`;
    process.env.BATCH_MOCKUP_OBJECT_ROOT = path.join(root, 'objects');
    process.env.BATCH_MOCKUP_PROJECT_ROOT = project;
    process.env.BATCH_MOCKUP_ORIGIN = 'http://127.0.0.1:3188';
    process.env.BATCH_MOCKUP_FAULT_TESTING = '1';
    database = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'test', password, port, persistent: false, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => { }, onError: () => { } });
    await database.initialise();
    await database.start();
    await initializeLocalDatabase();
    const raw = Buffer.alloc(64 * 64 * 4);
    for (let p = 0; p < 64 * 64; p++) {
        const x = p % 64, y = Math.floor(p / 64), center = x > 16 && x < 48 && y > 16 && y < 48;
        raw.set(center ? [230, 20, 30, 255] : [30, 70, 190, 255], p * 4);
    }
    image = await storePng(await sharp(raw, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer(), '合成测试图', 'source');
}, 60000);
beforeEach(async () => { await db() `TRUNCATE batch_mockup.attempts,batch_mockup.steps,batch_mockup.runs,batch_mockup.orders`; });
afterAll(async () => { await closeDatabase(); await database?.stop(); if (root)
    await rm(root, { recursive: true, force: true }); });
async function order(graphic = false): Promise<LocalOrder> { const o = annotatedOrder(randomUUID(), 'local test', '通华驾校\n教 练', '图形加字', image, graphic ? image : undefined); await saveOrder(o); expect(validateRequirement(o.requirement, o.source).issues).toEqual([]); return o; }
const plan = (o: LocalOrder) => planArtwork(o.requirement, o.requirement.artworks[0].id);
async function run(o: LocalOrder, failAt: string | null = null) { const queued = await enqueue(o, plan(o), randomUUID(), failAt), claimed = await claim('worker-a'); expect(claimed?.id).toBe(queued.id); await executeRun(claimed!); return (await readRun(queued.id))!; }
const req = (route: string, body: unknown, origin = 'http://127.0.0.1:3188') => new Request(`http://127.0.0.1:3188/api/batch-mockup/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': origin }, body: JSON.stringify(body) });
describe('real local PostgreSQL and actual pixels (no provider)', () => {
    it('stores bytes with real SHA and checks font glyph coverage', async () => { const bytes = await imageBytes(image.id); expect(sha256(bytes)).toBe(image.id); expect((await sharp(bytes).metadata()).width).toBe(64); const font = await readFile(path.join(project, 'public/fonts/DOUYINSANSBOLD.TTF')); expect(missingGlyphs(font, '通华驾校\n教 练')).toEqual([]); expect(missingGlyphs(font, '\u{10FFFF}')).toEqual(['\u{10FFFF}']); });
    it('rejects unsupported glyphs instead of generating missing-glyph boxes', async () => { const o = await order(), c = o.requirement.artworks[0].components[0]; if (c.kind !== 'text' || c.content.kind !== 'exact')
        throw Error(); c.content.value = '\u{10FFFF}'; await expect(renderText(c)).rejects.toThrow('缺少字符'); });
    it('actual exterior removal preserves inner colored pixels', async () => { const o = await order(true), bytes = await removeExterior(await imageBytes(image.id), o.requirement.artworks[0].background), data = await sharp(bytes).ensureAlpha().raw().toBuffer(); expect(data[3]).toBe(0); expect([...data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)]).toEqual([230, 20, 30, 255]); });
    it('handles a narrow dark border of the same blue hue while preserving white and red artwork', async () => { const o = await order(true), bytes = await imageBytes(image.id), { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true }); for (let x = 0; x < 64; x++)
        data.set([12, 28, 76, 255], x * 4); data.set([255, 255, 255, 255], (20 * 64 + 20) * 4); const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(); const output = await sharp(await removeExterior(png, o.requirement.artworks[0].background)).raw().toBuffer(); expect(output[3]).toBe(0); expect([...output.subarray((20 * 64 + 20) * 4, (20 * 64 + 20) * 4 + 4)]).toEqual([255, 255, 255, 255]); expect(output[(32 * 64 + 32) * 4 + 3]).toBe(255); });
    it('rejects a heterogeneous border instead of treating scene content as background', async () => { const o = await order(true), { data, info } = await sharp(await imageBytes(image.id)).raw().toBuffer({ resolveWithObject: true }); for (let p = 0; p < 64 * 64; p++)
        if (p % 64 > 32)
            data.set([190, 150, 20, 255], p * 4); const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer(); await expect(removeExterior(png, o.requirement.artworks[0].background)).rejects.toThrow('外底不一致'); });
    it('does not silently ignore protected regions', async () => { const o = await order(true), a = o.requirement.artworks[0]; a.background.preserveRegions = [{ useId: o.requirement.materialUses[0].id, region: { x: 0, y: 0, width: .1, height: .1 }, description: '有效底色' }]; await expect(removeExterior(await imageBytes(image.id), a.background)).rejects.toThrow('保护规则'); });
    it('crop uses correct original pixels and rejects out of bounds', async () => { const bytes = await imageBytes(image.id); expect((await sharp(await crop(bytes, { x: .25, y: .25, width: .5, height: .5 })).metadata()).width).toBe(32); await expect(crop(bytes, { x: .8, y: 0, width: .4, height: 1 })).rejects.toThrow('选区'); });
    it('renders Chinese, saves exact string, real transparent artwork and a mockup', async () => { const o = await order(), r = await run(o); expect(r.status, r.error ?? '').toBe('completed'); expect(r.artworkArtifactId).toBeTruthy(); expect(r.mockupArtifactId).toBeTruthy(); const art = await imageBytes(r.artworkArtifactId!), raw = await sharp(art).ensureAlpha().raw().toBuffer(); expect(raw.some((v, i) => i % 4 === 3 && v === 0)).toBe(true); expect(raw.some((v, i) => i % 4 === 3 && v > 0)).toBe(true); expect((await readSteps(r.id)).find(s => s.kind === 'render-text')?.output?.text).toBe('通华驾校\n教 练'); expect((await readSteps(r.id)).find(s => s.kind === 'review')?.output?.checks?.every(c => c.status === 'uncertain')).toBe(true); });
    it('hybrid image selects, removes only exterior, renders words and composes', async () => { const r = await run(await order(true)); expect(r.status, r.error ?? '').toBe('completed'); const steps = await readSteps(r.id); expect(steps.find(s => s.kind === 'cutout')?.output?.images).toHaveLength(1); expect(steps.find(s => s.kind === 'compose-artwork')?.output?.images).toHaveLength(1); });
    it('concurrent duplicate submissions and two workers produce one active run and one lease', async () => { const o = await order(), p = plan(o); const [a, b] = await Promise.all([enqueue(o, p, randomUUID()), enqueue(o, p, randomUUID())]); expect(a.id).toBe(b.id); const claims = await Promise.all([claim('a'), claim('b')]); expect(claims.filter(Boolean)).toHaveLength(1); });
    it('same operation key is idempotent after completion; new key explicitly makes a new version', async () => { const o = await order(), r = await run(o); expect((await enqueue(o, plan(o), r.operationId)).id).toBe(r.id); expect((await enqueue(o, plan(o), randomUUID())).id).not.toBe(r.id); });
    it('CAS rejects stale requirements and operation IDs cannot change meaning', async () => { const o = await order(), r = await run(o), n = structuredClone(o.requirement); n.revision++; await compareAndSaveRequirement(o.id, 1, n); await expect(compareAndSaveRequirement(o.id, 1, n)).rejects.toThrow('其他操作'); const fresh = (await readOrder(o.id))!; await expect(enqueue(fresh, plan(fresh), r.operationId)).rejects.toThrow('其他需求版本'); });
    it('failed mockup retains completed artwork, resume reuses every completed step', async () => { const o = await order(true), r = await run(o, 'compose-mockup'); expect(r.status).toBe('failed'); expect(r.artworkArtifactId).toBeTruthy(); expect(r.mockupArtifactId).toBeNull(); const steps = await readSteps(r.id), art = await imageBytes(r.artworkArtifactId!); await resumeRun(r.id); const lease = await claim('b'); await executeRun(lease!); const done = (await readRun(r.id))!; expect(done.status, done.error ?? '').toBe('completed'); expect(done.artworkArtifactId).toBe(r.artworkArtifactId); expect(await imageBytes(done.artworkArtifactId!)).toEqual(art); const now = await readSteps(r.id); for (const s of steps.filter(s => s.status === 'completed'))
        expect(now.find(n => n.id === s.id)?.executions).toBe(s.executions); expect(now.find(s => s.kind === 'compose-mockup')?.executions).toBe(2); });
    it('failure at cutout preserves source and resumes without selecting again', async () => { const r = await run(await order(true), 'cutout'); expect(r.status).toBe('failed'); const old = (await readSteps(r.id)).find(s => s.kind === 'select')!; expect(old.output?.images[0].artifactId).toBe(image.id); await resumeRun(r.id); await executeRun((await claim('b'))!); expect((await readRun(r.id))?.status).toBe('completed'); expect((await readSteps(r.id)).find(s => s.id === old.id)?.executions).toBe(1); });
    it('expired worker cannot overwrite a new lease result', async () => { const o = await order(); await enqueue(o, plan(o), randomUUID()); const a = (await claim('a'))!; await db() `UPDATE batch_mockup.runs SET lease_until=now()-interval '1 second' WHERE id=${a.id}`; const b = (await claim('b'))!; expect(b.fence).toBe(a.fence + 1); await expect(updateRun(a, { error: 'stale' })).rejects.toThrow('过期任务'); await executeRun(b); expect((await readRun(b.id))?.status).toBe('completed'); });
    it('submitting without receipt becomes unknown on recovery and cannot submit again', async () => { const o = await order(); await enqueue(o, plan(o), randomUUID()); const r = (await claim('a'))!; expect((await beginAttempt(r, 'provider-step', 'test-key')).fresh).toBe(true); expect((await beginAttempt(r, 'provider-step', 'test-key')).fresh).toBe(false); await db() `UPDATE batch_mockup.runs SET lease_until=now()-interval '1 second' WHERE id=${r.id}`; expect(await claim('b')).toBeNull(); expect((await readRun(r.id))?.status).toBe('unknown'); await expect(resumeRun(r.id)).rejects.toThrow('未知'); });
    it('accepted receipt survives connection restart before a download (receipt contract test only)', async () => { const o = await order(); await enqueue(o, plan(o), randomUUID()); const r = (await claim('a'))!; await beginAttempt(r, 'external-step', 'receipt-key'); await saveAttemptReceipt(r, 'receipt-key', { providerTaskId: 'synthetic-receipt', url: 'https://example.invalid/result' }); await closeDatabase(); const again = await beginAttempt(r, 'external-step', 'receipt-key'); expect(again.fresh).toBe(false); expect(again.status).toBe('accepted'); expect(again.receipt).toEqual({ providerTaskId: 'synthetic-receipt', url: 'https://example.invalid/result' }); });
    it('unsupported real generation keeps input candidate and reports failure honestly', async () => { const o = await order(true), c = o.requirement.artworks[0].components[0]; if (c.kind !== 'graphic')
        throw Error(); c.mode = 'edit'; o.requirement.artworks[0].changes.push({ id: 'remove', componentId: c.id, action: { kind: 'remove', targetDescription: 'R' }, sourceUseId: o.requirement.materialUses[0].id, selection: { kind: 'whole' }, evidenceIds: [o.requirement.evidence[0].id], preserve: ['其他内容'] }); await db() `UPDATE batch_mockup.orders SET body=${db().json(o as never)} WHERE id=${o.id}`; const r = await run(o); expect(r.status).toBe('failed'); expect(r.error).toContain('真实图片服务'); expect((await readSteps(r.id)).find(s => s.kind === 'select')?.output?.images[0].artifactId).toBe(image.id); });
    it('accepts Next normalized loopback URL but rejects foreign host and port', async () => { await order(); expect((await getState(new Request('http://localhost:3188/api/batch-mockup/state', { headers: { Host: '127.0.0.1:3188' } }))).status).toBe(200); expect((await getState(new Request('http://localhost:3188/api/batch-mockup/state', { headers: { Host: 'attacker.example:3188' } }))).status).toBe(400); expect((await getState(new Request('http://localhost:3999/api/batch-mockup/state'))).status).toBe(400); });
    it('HTTP persists state and rejects foreign write origin and stale revision', async () => { const o = await order(); const input = { orderId: o.id, artworkId: o.requirement.artworks[0].id, expectedRevision: 1, operationId: randomUUID() }; expect((await postRun(req('runs', input, 'https://foreign.invalid'))).status).toBe(400); expect((await postRun(req('runs', { ...input, expectedRevision: 2 }))).status).toBe(400); expect((await postRun(req('runs', input))).status).toBe(200); await closeDatabase(); const response = await getState(new Request('http://127.0.0.1:3188/api/batch-mockup/state')); const state = await response.json(); expect(state.orders).toHaveLength(1); expect(state.runs).toHaveLength(1); });
    it('HTTP text edit increments revision while preserving existing artifact and old run', async () => { const o = await order(), r = await run(o); const response = await postRequirement(req('requirements', { orderId: o.id, componentId: o.requirement.artworks[0].components[0].id, text: '新文字\nA B', expectedRevision: 1 })); expect(response.status, JSON.stringify(await response.clone().json())).toBe(200); expect((await readOrder(o.id))?.requirement.revision).toBe(2); expect((await readRun(r.id))?.requirement.revision).toBe(1); expect(await imageBytes(r.artworkArtifactId!)).toBeTruthy(); });
});
