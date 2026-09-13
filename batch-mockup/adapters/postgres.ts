import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { localConfig } from './local-config';
import type { LocalOrder, StoredImage, StoredRun, StoredStep, StepOutput } from '../application/runtime-types';
import type { ProductionPlan, Requirement } from '../domain/contracts';
type Database = ReturnType<typeof postgres>;
let database: Database | undefined;
export function db() {
    if (!database)
        database = postgres(localConfig().databaseUrl, { max: 4, idle_timeout: 5, connect_timeout: 5, onnotice: () => { } });
    return database;
}
export async function closeDatabase() { const old = database; database = undefined; await old?.end({ timeout: 5 }); }
export async function initializeLocalDatabase() {
    const sql = db();
    await sql `CREATE SCHEMA IF NOT EXISTS batch_mockup`;
    await sql `CREATE TABLE IF NOT EXISTS batch_mockup.orders(id text PRIMARY KEY, body jsonb NOT NULL)`;
    await sql `CREATE TABLE IF NOT EXISTS batch_mockup.images(id text PRIMARY KEY, body jsonb NOT NULL)`;
    await sql `CREATE TABLE IF NOT EXISTS batch_mockup.runs(
    id text PRIMARY KEY, order_id text NOT NULL REFERENCES batch_mockup.orders(id), artwork_id text NOT NULL,
    operation_id text NOT NULL UNIQUE, status text NOT NULL, fence integer NOT NULL DEFAULT 0,
    worker_id text, lease_until timestamptz, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql `CREATE UNIQUE INDEX IF NOT EXISTS one_active_artwork ON batch_mockup.runs(order_id,artwork_id) WHERE status IN ('queued','running','unknown')`;
    await sql `CREATE TABLE IF NOT EXISTS batch_mockup.steps(
    run_id text NOT NULL REFERENCES batch_mockup.runs(id), id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(run_id,id))`;
    await sql `CREATE TABLE IF NOT EXISTS batch_mockup.attempts(
    operation_key text PRIMARY KEY, run_id text NOT NULL REFERENCES batch_mockup.runs(id), step_id text NOT NULL,
    status text NOT NULL CHECK(status IN ('submitting','accepted','unknown','rejected','completed')), receipt jsonb, updated_at timestamptz NOT NULL DEFAULT now())`;
}
export async function saveOrder(order: LocalOrder) {
    const sql = db();
    await sql `INSERT INTO batch_mockup.orders(id,body) VALUES(${order.id},${sql.json(order as never)}) ON CONFLICT(id) DO NOTHING`;
}
export async function readOrder(id: string): Promise<LocalOrder | null> { const rows = await db() `SELECT body FROM batch_mockup.orders WHERE id=${id}`; return rows[0]?.body as LocalOrder ?? null; }
export async function listOrders(): Promise<LocalOrder[]> { return (await db() `SELECT body FROM batch_mockup.orders ORDER BY id`).map(row => row.body as LocalOrder); }
export async function saveImage(image: StoredImage) { const sql = db(); await sql `INSERT INTO batch_mockup.images(id,body) VALUES(${image.id},${sql.json(image as never)}) ON CONFLICT(id) DO NOTHING`; }
export async function readImage(id: string): Promise<StoredImage | null> { return (await db() `SELECT body FROM batch_mockup.images WHERE id=${id}`)[0]?.body as StoredImage ?? null; }
export async function listImages(): Promise<StoredImage[]> { return (await db() `SELECT body FROM batch_mockup.images`).map(row => row.body as StoredImage); }
function runRow(row: Record<string, unknown>): StoredRun {
    return { ...(row.body as StoredRun), status: row.status as StoredRun['status'], fence: Number(row.fence), workerId: row.worker_id as string | null,
        leaseUntil: row.lease_until ? new Date(row.lease_until as string).toISOString() : null,
        createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() };
}
export async function readRun(id: string): Promise<StoredRun | null> { const rows = await db() `SELECT * FROM batch_mockup.runs WHERE id=${id}`; return rows[0] ? runRow(rows[0]) : null; }
export async function listRuns(): Promise<StoredRun[]> { return (await db() `SELECT * FROM batch_mockup.runs ORDER BY created_at DESC LIMIT 100`).map(runRow); }
export async function readSteps(runId: string): Promise<StoredStep[]> { return (await db() `SELECT body FROM batch_mockup.steps WHERE run_id=${runId} ORDER BY body->>'startedAt'`).map(row => row.body as StoredStep); }
export async function enqueue(order: LocalOrder, plan: ProductionPlan, operationId: string, failAt: string | null = null): Promise<StoredRun> {
    const sql = db();
    return sql.begin(async (tx) => {
        // Same-artwork submissions serialize on the order; no external work occurs in the transaction.
        const [row] = await tx `SELECT body FROM batch_mockup.orders WHERE id=${order.id} FOR UPDATE`;
        if (!row || (row.body as LocalOrder).requirement.revision !== order.requirement.revision)
            throw new Error('要求已经更新，请重新读取后制作');
        const existing = await tx `SELECT * FROM batch_mockup.runs WHERE operation_id=${operationId} OR (order_id=${order.id} AND artwork_id=${plan.artworkId} AND status IN ('queued','running','unknown')) ORDER BY created_at DESC LIMIT 1`;
        if (existing[0]) {
            const run = runRow(existing[0]);
            if (run.orderId !== order.id || run.artworkId !== plan.artworkId)
                throw new Error('操作编号已用于另一份图稿');
            if (run.plan.requirementHash !== plan.requirementHash)
                throw new Error('已有任务使用其他需求版本，请等待或查看原任务');
            return run;
        }
        const now = new Date().toISOString();
        const run: StoredRun = { id: randomUUID(), orderId: order.id, artworkId: plan.artworkId, operationId, plan, requirement: order.requirement,
            status: 'queued', fence: 0, workerId: null, leaseUntil: null, createdAt: now, updatedAt: now, error: null,
            artworkArtifactId: null, mockupArtifactId: null, failAt, faultConsumed: false };
        await tx `INSERT INTO batch_mockup.runs(id,order_id,artwork_id,operation_id,status,body) VALUES(${run.id},${order.id},${plan.artworkId},${operationId},'queued',${tx.json(run as never)})`;
        return run;
    }) as Promise<StoredRun>;
}
export async function claim(workerId: string): Promise<StoredRun | null> {
    const sql = db();
    return sql.begin(async (tx) => {
        const rows = await tx `SELECT * FROM batch_mockup.runs WHERE status='queued' OR (status='running' AND lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!rows[0])
            return null;
        const run = runRow(rows[0]);
        const uncertain = await tx `SELECT operation_key FROM batch_mockup.attempts WHERE run_id=${run.id} AND status IN ('submitting','unknown') LIMIT 1`;
        if (uncertain.length) {
            await tx `UPDATE batch_mockup.runs SET status='unknown',worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=${run.id}`;
            return null;
        }
        const [row] = await tx `UPDATE batch_mockup.runs SET status='running',fence=fence+1,worker_id=${workerId},lease_until=now()+interval '30 seconds',updated_at=now() WHERE id=${run.id} RETURNING *`;
        return runRow(row);
    }) as Promise<StoredRun | null>;
}
export async function heartbeat(run: StoredRun) {
    const rows = await db() `UPDATE batch_mockup.runs SET lease_until=now()+interval '30 seconds' WHERE id=${run.id} AND status='running' AND fence=${run.fence} AND worker_id=${run.workerId} AND lease_until>now() RETURNING id`;
    if (!rows.length)
        throw new Error('任务执行权已失效');
}
async function assertLease(tx: Database, run: StoredRun) {
    const rows = await tx `SELECT id FROM batch_mockup.runs WHERE id=${run.id} AND status='running' AND fence=${run.fence} AND worker_id=${run.workerId} AND lease_until>now() FOR UPDATE`;
    if (!rows.length)
        throw new Error('过期任务不能更新当前状态');
}
export async function writeStep(run: StoredRun, step: StoredStep) {
    await db().begin(async (tx) => {
        await assertLease(tx as unknown as Database, run);
        await tx `INSERT INTO batch_mockup.steps(run_id,id,body) VALUES(${run.id},${step.id},${tx.json(step as never)}) ON CONFLICT(run_id,id) DO UPDATE SET body=EXCLUDED.body`;
    });
}
export async function updateRun(run: StoredRun, patch: Partial<Pick<StoredRun, 'error' | 'artworkArtifactId' | 'mockupArtifactId' | 'faultConsumed'>>, status: StoredRun['status'] = 'running') {
    await db().begin(async (tx) => {
        await assertLease(tx as unknown as Database, run);
        await tx `UPDATE batch_mockup.runs SET body=body || ${tx.json(patch as never)},status=${status},updated_at=now(),lease_until=CASE WHEN ${status}='running' THEN lease_until ELSE NULL END WHERE id=${run.id}`;
    });
    Object.assign(run, patch, { status });
}
export async function resumeRun(id: string) {
    await db().begin(async (tx) => {
        const rows = await tx `SELECT * FROM batch_mockup.runs WHERE id=${id} FOR UPDATE`;
        if (!rows[0])
            throw new Error('任务不存在');
        if (rows[0].status === 'queued' || rows[0].status === 'running')
            return;
        if (rows[0].status !== 'failed')
            throw new Error('只能恢复已明确失败的任务；未知提交必须先查询');
        const order = await tx `SELECT body FROM batch_mockup.orders WHERE id=${rows[0].order_id}`;
        const old = rows[0].body as StoredRun;
        if ((order[0].body as LocalOrder).requirement.revision !== old.requirement.revision)
            throw new Error('要求已变化，旧任务不可附着到新稿');
        const attempts = await tx `SELECT operation_key FROM batch_mockup.attempts WHERE run_id=${id} AND status IN ('submitting','unknown')`;
        if (attempts.length)
            throw new Error('供应商提交结果未知，禁止重新执行');
        await tx `UPDATE batch_mockup.runs SET status='queued',worker_id=NULL,lease_until=NULL,body=body || '{"error":null}'::jsonb,updated_at=now() WHERE id=${id}`;
    });
    return readRun(id);
}
export async function beginAttempt(run: StoredRun, stepId: string, operationKey: string) {
    return db().begin(async (tx) => {
        await assertLease(tx as unknown as Database, run);
        const [existing] = await tx `SELECT * FROM batch_mockup.attempts WHERE operation_key=${operationKey}`;
        if (existing && (existing.run_id !== run.id || existing.step_id !== stepId))
            throw new Error('提交编号已被其他步骤使用');
        if (existing)
            return { fresh: false, status: existing.status as string, receipt: existing.receipt as unknown };
        await tx `INSERT INTO batch_mockup.attempts(operation_key,run_id,step_id,status) VALUES(${operationKey},${run.id},${stepId},'submitting')`;
        return { fresh: true, status: 'submitting', receipt: null };
    });
}
export async function saveAttemptReceipt(run: StoredRun, operationKey: string, receipt: Record<string, unknown>) {
    await db().begin(async (tx) => {
        await assertLease(tx as unknown as Database, run);
        const rows = await tx `UPDATE batch_mockup.attempts SET status='accepted',receipt=${tx.json(receipt as never)},updated_at=now() WHERE operation_key=${operationKey} AND run_id=${run.id} AND status='submitting' RETURNING operation_key`;
        if (!rows.length)
            throw new Error('回执与当前提交不匹配');
    });
}
export async function completeAttempt(run: StoredRun, operationKey: string) {
    await db().begin(async (tx) => { await assertLease(tx as unknown as Database, run); await tx `UPDATE batch_mockup.attempts SET status='completed',updated_at=now() WHERE operation_key=${operationKey} AND run_id=${run.id} AND status='accepted'`; });
}
export async function compareAndSaveRequirement(id: string, expected: number, next: Requirement) {
    if (next.revision !== expected + 1)
        throw new Error('保存版本号必须连续递增');
    const sql = db();
    const rows = await sql `UPDATE batch_mockup.orders SET body=jsonb_set(body,'{requirement}',${sql.json(next as never)}) WHERE id=${id} AND (body->'requirement'->>'revision')::int=${expected} RETURNING id`;
    if (!rows.length)
        throw new Error('要求已被其他操作更新');
}
export function completedOutput(steps: StoredStep[], id: string): StepOutput | null { return steps.find(step => step.id === id && step.status === 'completed')?.output ?? null; }
