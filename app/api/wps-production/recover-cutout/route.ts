import { NextResponse } from 'next/server';
import { z } from 'zod';
import { productionUser, productionStateKey } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogDatabase, catalogTransaction } from '@/lib/server/catalog-database';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { readCutoutJob } from '@/lib/server/artwork-cutout-store';
import { retainJobFiles, type ArtworkJobInput } from '@/lib/server/artwork-job-store';
import { assertProductionArtworkSnapshot, assertProductionSharedSnapshot } from '@/lib/production-artwork-snapshot';
import { verifyLiveArtworkSource } from '@/lib/server/artwork-preflight';
import { safeErrorText } from '@/lib/artwork-reliability';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
const schema = z.object({ id: z.string().uuid(), requestId: z.string().uuid(), failedKey: z.string().regex(/^[\da-f]{64}$/u),
  mode: z.enum(['auto', 'standard', 'meitu']), confirmCharge: z.literal(true) }).strict();
export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const input = schema.parse(await request.json());
    const stored = (await catalogDatabase().query('SELECT * FROM artwork_jobs WHERE id=$1 AND state_key=$2', [input.id, productionStateKey()])).rows[0];
    if (!stored) throw new Error('找不到本工作台的原任务');
    const originalInput = stored.input as ArtworkJobInput;
    await verifyLiveArtworkSource(originalInput.source);
    const current = await readWpsProductionState();
    assertProductionArtworkSnapshot(current, stored.unit_id, stored.snapshot);
    if (originalInput.sharedSnapshot) assertProductionSharedSnapshot(current, stored.unit_id, originalInput.sharedSnapshot);
    const failed = await readCutoutJob(input.failedKey);
    if (!failed || failed.status !== 'failed' || failed.phase !== 'finished') throw new Error('只能显式重试有确定失败回执的抠图，未知提交必须先核实');
    const result = await catalogTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`artwork:${productionStateKey()}:${stored.unit_id}`]);
      const job = (await client.query('SELECT * FROM artwork_jobs WHERE id=$1 AND state_key=$2 FOR UPDATE', [input.id, productionStateKey()])).rows[0];
      if (!job) throw new Error('原任务已不存在');
      const jobInput = job.input as ArtworkJobInput;
      if (jobInput.cutoutRecovery?.requestId === input.requestId) return { id: job.id, existing: true, status: job.status };
      if (!['failed', 'review'].includes(job.status)) throw new Error('原任务仍在运行或已完成，请刷新进度，不重复创建尝试');
      if (job.candidate?.cutout?.receipt?.jobKey !== input.failedKey || job.candidate?.cutout?.receipt?.sourceSha256 !== failed.receipt.sourceSha256) throw new Error('失败回执不属于当前保留候选，禁止拿其他订单的任务重试');
      const unknown = await client.query("SELECT 1 FROM artwork_job_steps WHERE job_id=$1 AND status IN ('unknown','running') AND (stage='generation' OR step_key LIKE 'mediakit:/api/v1/tools-sync/enhance-image:%')", [job.id]);
      if (unknown.rowCount) throw new Error('仍有未知付费步骤，不能再次提交');
      const active = await client.query("SELECT 1 FROM artwork_jobs WHERE state_key=$1 AND unit_id=$2 AND id<>$3 AND status IN ('queued','running','unknown')", [productionStateKey(), job.unit_id, job.id]);
      if (active.rowCount) throw new Error('该位置已有其他活动任务');
      const changed: ArtworkJobInput = { ...jobInput,
        cutoutRecovery: { requestId: input.requestId, failedKey: input.failedKey, sourceSha256: failed.receipt.sourceSha256, mode: input.mode, requestedAt: new Date().toISOString() },
        cutoutRecoveryHistory: [...(jobInput.cutoutRecoveryHistory ?? []), { previous: jobInput.cutoutRecovery ?? null, candidate: job.candidate, error: job.error }] };
      await retainJobFiles(client, job.id, changed);
      await client.query("UPDATE artwork_jobs SET input=$3,status='queued',owner=NULL,lease_until=NULL,error=NULL,message='复用原生图，仅显式重试失败抠图；可能产生抠图费用',updated_at=now() WHERE id=$1 AND state_key=$2", [job.id, productionStateKey(), changed]);
      return { id: job.id, existing: false, status: 'queued' };
    });
    return NextResponse.json({ ...result, reusedGenerationCheckpoints: true, mayChargeCutout: true }, { status: 202 });
  } catch (error) { return NextResponse.json({ error: safeErrorText(error) }, { status: error instanceof CatalogHttpError ? error.status : 409 }); }
}
