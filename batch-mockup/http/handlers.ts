import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localConfig } from '../adapters/local-config';
import { compareAndSaveRequirement, enqueue, listImages, listOrders, listRuns, readOrder, readSteps, resumeRun } from '../adapters/postgres';
import { validateRequirement } from '../domain/validation';
import { planArtwork } from '../domain/planner';
import { imageBytes } from '../adapters/images';
function access(request: Request, write = false) {
    const config = localConfig(), url = new URL(request.url);
    const expected = new URL(config.origin);
    // Next normalizes loopback request.url to localhost even when the browser used 127.0.0.1.
    const allowedHost = (value: string) => value === `127.0.0.1:${expected.port}` || value === `localhost:${expected.port}`;
    if (url.protocol !== 'http:' || !allowedHost(url.host) || request.headers.has('host') && !allowedHost(request.headers.get('host')!))
        throw new Error('请求必须来自本地验收工作台');
    if (write && request.headers.get('origin') !== config.origin)
        throw new Error('写入来源不匹配');
}
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } }); }
async function body(request: Request) { if (Number(request.headers.get('content-length') ?? 0) > 30000)
    throw new Error('请求过大'); const text = await request.text(); if (text.length > 30000)
    throw new Error('请求过大'); return JSON.parse(text) as unknown; }
async function handle(work: () => Promise<Response>) { try {
    return await work();
}
catch (error) {
    return json({ error: error instanceof Error ? error.message : '操作失败' }, 400);
} }
export function getState(request: Request) {
    return handle(async () => {
        access(request);
        const [orders, runs, images] = await Promise.all([listOrders(), listRuns(), listImages()]);
        const detailed = await Promise.all(runs.map(async (run) => ({ ...run, steps: await readSteps(run.id) })));
        return json({ mode: 'offline', orders, runs: detailed, images });
    });
}
const runInput = z.object({ orderId: z.string().min(1), artworkId: z.string().min(1), operationId: z.string().uuid(), expectedRevision: z.number().int().positive(), failAt: z.enum(['compose-mockup', 'cutout']).optional() }).strict();
export function postRun(request: Request) {
    return handle(async () => {
        access(request, true);
        const input = runInput.parse(await body(request));
        if (input.failAt && !localConfig().faultTesting)
            throw new Error('未启用本地故障测试');
        const order = await readOrder(input.orderId);
        if (!order)
            throw new Error('任务不存在');
        if (order.requirement.revision !== input.expectedRevision)
            throw new Error('要求已更新，请刷新后再制作');
        const validated = validateRequirement(order.requirement, order.source);
        if (!validated.requirement)
            throw new Error(validated.issues.map(i => i.message).join('；'));
        const plan = planArtwork({ ...validated.requirement, issues: [...validated.requirement.issues, ...validated.issues] }, input.artworkId);
        return json(await enqueue(order, plan, input.operationId, input.failAt ?? null));
    });
}
export function postResume(request: Request) { return handle(async () => { access(request, true); const input = z.object({ runId: z.string().uuid() }).strict().parse(await body(request)); return json(await resumeRun(input.runId)); }); }
export function postRequirement(request: Request) {
    return handle(async () => {
        access(request, true);
        const input = z.object({ orderId: z.string(), componentId: z.string(), text: z.string().min(1).max(500), expectedRevision: z.number().int().positive() }).strict().parse(await body(request));
        const order = await readOrder(input.orderId);
        if (!order)
            throw new Error('任务不存在');
        const next = structuredClone(order.requirement), component = next.artworks.flatMap(a => a.components).find(c => c.id === input.componentId);
        if (component?.kind !== 'text' || component.content.kind !== 'exact')
            throw new Error('当前组件不能直接改字');
        const evidenceId = randomUUID();
        next.evidence.push({ id: evidenceId, origin: { kind: 'user-amendment', amendmentId: randomUUID(), actorId: 'local-operator', at: new Date().toISOString() }, statement: `本次准确文字：${input.text}`, certainty: 'explicit', supersedes: component.content.evidenceIds });
        component.content = { kind: 'exact', value: input.text, evidenceIds: [evidenceId] };
        next.revision = input.expectedRevision + 1;
        for (const artwork of next.artworks)
            for (const check of artwork.requiredChecks)
                if (check.category === 'text' && check.targetId === component.id) {
                    check.expected = input.text;
                    check.evidenceIds = [evidenceId];
                }
        const validated = validateRequirement(next, order.source);
        if (!validated.requirement)
            throw new Error('修改后的需求结构不合法');
        await compareAndSaveRequirement(order.id, input.expectedRevision, validated.requirement);
        return json({ saved: true, revision: next.revision });
    });
}
export function getImage(request: Request, id: string) { return handle(async () => { access(request); const bytes = await imageBytes(id); return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600', ...(new URL(request.url).searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${id.slice(0, 16)}.png"` } : {}) } }); }); }
