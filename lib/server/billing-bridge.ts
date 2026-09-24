import { randomUUID } from 'node:crypto';
import { CatalogHttpError } from './catalog-auth';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { tenantByWorkspace } from './tenant-scope';
import {
  ceilingMicroCents, currentPrices, holdCredits, microToCents, releaseHold, settleHold,
  type AttemptOutcome, type HoldKind,
} from './credits';

/**
 * Bridge between the batch workspace (plain JavaScript, addressed by workspace name) and the
 * credit ledger (addressed by tenant).
 *
 * Every paid unit of work is reserved through here, whether it was started by a browser or by
 * the background flow that continues on its own after a sync. Holding at the reservation point
 * is the only position that covers both.
 */

export type ReservationPlan = { route?: 'generate' | 'enhance' | 'reuse'; analyze?: boolean; recognize?: boolean };

const holdIdFor = (workspace: string, jobId: string) => `${workspace}:${jobId}`;

/** An external paid call must still have an active hold at execution time. */
export async function assertCreditReservation(workspace: string, jobId: string) {
  if (workspace === 'main') return;
  const tenant = await tenantByWorkspace(workspace);
  if (!tenant) throw new CatalogHttpError(403, '工作区不存在或已停用');
  if (tenant.billingMode === 'exempt') return;
  const hold = await catalogDatabase().query(
    "SELECT 1 FROM credit_holds WHERE id=$1 AND tenant_id=$2 AND state='held'",
    [holdIdFor(workspace, jobId), tenant.id]);
  if (!hold.rowCount) throw new CatalogHttpError(402, '缺少有效积分冻结，未调用供应商，请管理员核对任务');
}

/**
 * Reserve the worst-case cost before a job is queued.
 *
 * Returns `null` when nothing needs charging, which is the normal case for the internal
 * workspace that carries the WPS delivery: it is exempt, so the balance is never touched and
 * a zero balance can never stall it.
 */
export async function reserveCredits(input: {
  workspace: string; jobId: string; kind: HoldKind; jobRef: string; plan: ReservationPlan;
}) {
  const tenant = await tenantByWorkspace(input.workspace);
  if (!tenant) throw new CatalogHttpError(403,'工作区不存在或已停用');
  if (tenant.billingMode==='exempt') return null;

  const snapshot = await currentPrices();
  const amountCents = microToCents(ceilingMicroCents(snapshot, input.plan));
  const id = holdIdFor(input.workspace, input.jobId);

  await catalogTransaction(client => holdCredits(client, {
    id, tenantId: tenant.id, kind: input.kind, jobRef: input.jobRef,
    billingMode: tenant.billingMode, amountCents, snapshot,
  }));
  return { holdId: id, tenantId: tenant.id, amountCents, billingMode: tenant.billingMode };
}

/** Settle from the per-call receipts once the work is over. */
export async function settleCredits(workspace: string, jobId: string, attempts: AttemptOutcome[]) {
  if(workspace==='main')return null;
  const tenant=(await catalogDatabase().query('SELECT id,billing_mode FROM tenants WHERE workspace=$1',[workspace])).rows[0];
  if(!tenant)throw new CatalogHttpError(403,'工作区不存在');
  if(tenant.billing_mode==='exempt')return null;
  return settleHold(holdIdFor(workspace, jobId), tenant.id, attempts);
}

/** Give everything back: the work never reached a provider. */
export async function releaseCredits(workspace: string, jobId: string, reason?: string) {
  if(workspace==='main')return null;
  const tenant=(await catalogDatabase().query('SELECT id,billing_mode FROM tenants WHERE workspace=$1',[workspace])).rows[0];
  if(!tenant)throw new CatalogHttpError(403,'工作区不存在');
  if(tenant.billing_mode==='exempt')return null;
  return releaseHold(holdIdFor(workspace, jobId), tenant.id, reason);
}

/** Receipt for one provider call, in the shape settlement expects. */
export const attempt = (action: AttemptOutcome['action'], certain: boolean, properties?: Record<string, unknown>): AttemptOutcome =>
  ({ action, billable: true, certain, attemptId: typeof properties?.attemptId==='string'?properties.attemptId:randomUUID(), properties });
