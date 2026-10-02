import { randomUUID } from 'node:crypto';
import { CatalogHttpError } from './catalog-auth';
import { catalogDatabase, catalogTransaction } from './catalog-database';

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: Record<string, unknown>[] }> };

// 'cutout' is the Meitu fine cut; 'cutout_standard' the Volcengine saliency cut; 'back_reference'
// the garment back view (Seedream). Split so each supplier is charged at its own cost.
export type BillableAction = 'analyze' | 'generate' | 'enhance' | 'cutout' | 'cutout_standard' | 'back_reference' | 'recognize';

/** Background-removal action for the engine that actually ran. */
export const cutoutAction = (engine: string): BillableAction => (engine === 'meitu' ? 'cutout' : 'cutout_standard');
export type HoldKind = 'analysis' | 'production' | 'recognize';

/** 1 credit = 1 cent; a price carries 1000 micro-cents so sub-cent actions stay exact. */
export const MICRO_PER_CENT = 1000;

export type PriceEntry = { action: BillableAction; costMicroCents: number; multiplierMilli: number; userMicroCents: number };
export type PriceSnapshot = { takenAt: string; unit: 'micro_cents'; rounding: 'ceil_at_settlement'; prices: PriceEntry[] };

/** Current prices, newest effective row per action. */
export async function currentPrices(): Promise<PriceSnapshot> {
  const rows = await catalogDatabase().query(
    `SELECT DISTINCT ON (action) action, cost_micro_cents, multiplier_milli
       FROM price_list WHERE effective_from <= now() ORDER BY action, effective_from DESC`);
  const prices = rows.rows.map(row => {
    const costMicroCents = Number(row.cost_micro_cents);
    const multiplierMilli = Number(row.multiplier_milli);
    return {
      action: row.action as BillableAction,
      costMicroCents, multiplierMilli,
      // Integer arithmetic throughout; the division is exact because multiplier is in milli.
      userMicroCents: Math.ceil((costMicroCents * multiplierMilli) / 1000),
    };
  });
  return { takenAt: new Date().toISOString(), unit: 'micro_cents', rounding: 'ceil_at_settlement', prices };
}

// Holds reserved before pricing v2 carry snapshots without the split actions; they settle at the
// price the account was quoted then.
const SNAPSHOT_FALLBACK: Partial<Record<BillableAction, BillableAction>> = { cutout_standard: 'cutout', back_reference: 'generate' };

export const priceOf = (snapshot: PriceSnapshot, action: BillableAction) => {
  const entry = snapshot.prices.find(price => price.action === action)
    ?? snapshot.prices.find(price => price.action === SNAPSHOT_FALLBACK[action]);
  if (!entry) throw new CatalogHttpError(503, `缺少 ${action} 的计费单价`);
  return entry;
};

/**
 * Worst-case cost of one reserved unit of work.
 *
 * The three production routes are mutually exclusive, not sequential, and a cut-out is only
 * appended when the output still carries a background — so the ceiling is one route plus at
 * most one cut-out, never all three.
 */
export function ceilingMicroCents(snapshot: PriceSnapshot, plan: { route?: 'generate' | 'enhance' | 'reuse'; analyze?: boolean; recognize?: boolean }) {
  let micro = 0;
  if (plan.analyze) micro += priceOf(snapshot, 'analyze').userMicroCents;
  if (plan.recognize) micro += priceOf(snapshot, 'recognize').userMicroCents * 2; // apron recognition may call twice
  if (plan.route) {
    if (plan.route === 'generate') micro += priceOf(snapshot, 'generate').userMicroCents;
    if (plan.route === 'enhance') micro += priceOf(snapshot, 'enhance').userMicroCents;
    micro += priceOf(snapshot, 'cutout').userMicroCents;
  }
  return micro;
}

export const microToCents = (micro: number) => Math.ceil(micro / MICRO_PER_CENT);

/**
 * Hold the ceiling before any paid call is made.
 *
 * Runs inside the caller's transaction so the hold, the task documents and the queue row all
 * commit together: a task that is queued without a hold would run for free, and a hold without
 * a task would freeze credits forever.
 */
export async function holdCredits(client: Client, input: {
  id: string; tenantId: string; kind: HoldKind; jobRef: string;
  billingMode: 'charge' | 'exempt'; amountCents: number; snapshot: PriceSnapshot;
}) {
  const amount = Math.max(0, Math.trunc(input.amountCents));
  const inserted = await client.query(
    `INSERT INTO credit_holds(id,tenant_id,kind,job_ref,billing_mode,amount_cents,price_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [input.id, input.tenantId, input.kind, input.jobRef, input.billingMode, amount, input.snapshot]);

  if (!inserted.rowCount) {
    // A repeat submission is fine; a different request reusing the same id is not.
    const existing = await client.query(
      'SELECT tenant_id, kind, job_ref, amount_cents FROM credit_holds WHERE id=$1', [input.id]);
    const row = existing.rows[0] as { tenant_id: string; kind: string; job_ref: string; amount_cents: string };
    if (row.tenant_id !== input.tenantId || row.kind !== input.kind || row.job_ref !== input.jobRef
      || Number(row.amount_cents) !== amount) {
      throw new CatalogHttpError(409, '同一个任务编号对应了不同的计费请求');
    }
    return { held: false as const };
  }

  // Exempt tenants keep a hold row for cost reporting, but their balance is never touched.
  if (input.billingMode === 'exempt' || amount === 0) return { held: true as const, charged: false as const };

  // Daily cap per Beijing day. Locking the account row first serialises concurrent holds, so two
  // requests cannot both pass the check. Open holds count at their reserved amount until settled.
  await client.query('SELECT 1 FROM credit_accounts WHERE tenant_id=$1 FOR UPDATE', [input.tenantId]);
  const today = await client.query(
    `SELECT t.daily_spend_cap_cents AS cap,
            COALESCE((SELECT sum(CASE h.state WHEN 'settled' THEN h.settled_cents WHEN 'released' THEN 0 ELSE h.amount_cents END)
                        FROM credit_holds h
                       WHERE h.tenant_id = t.id AND h.billing_mode = 'charge' AND h.id <> $2
                         AND h.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0) AS spent
       FROM tenants t WHERE t.id = $1`, [input.tenantId, input.id]);
  const { cap, spent } = today.rows[0] as { cap: string | null; spent: string };
  if (cap !== null && Number(spent) + amount > Number(cap)) {
    throw new CatalogHttpError(402, `今天已用 ${Number(spent)} 积分，本次最多需要 ${amount}，超过每日上限 ${Number(cap)}；明天自动恢复，或联系管理员调高`);
  }

  const charged = await client.query(
    `UPDATE credit_accounts SET balance_cents = balance_cents - $2, held_cents = held_cents + $2, updated_at = now()
      WHERE tenant_id = $1 AND balance_cents >= $2
      RETURNING balance_cents, held_cents`, [input.tenantId, amount]);
  if (!charged.rowCount) {
    throw new CatalogHttpError(402, `积分不足：本次最多需要 ${amount} 分，请联系管理员开通额度`);
  }
  const account = charged.rows[0] as { balance_cents: string; held_cents: string };
  await writeLedger(client, {
    tenantId: input.tenantId, kind: 'hold', amountCents: -amount,
    balanceAfter: Number(account.balance_cents), heldAfter: Number(account.held_cents),
    holdId: input.id, reason: `冻结：${input.kind} ${input.jobRef}`,
  });
  return { held: true as const, charged: true as const };
}

export type AttemptOutcome = { action: BillableAction; billable: boolean; certain: boolean; attemptId: string; properties?: Record<string, unknown> };

/**
 * Settle a hold from the per-call receipts.
 *
 * Amounts accumulate in micro-cents and are rounded once at the end: rounding each call
 * separately can push the total past the amount that was held.
 */
export async function settleHold(holdId: string, tenantId: string, attempts: AttemptOutcome[]) {
  return catalogTransaction(async raw => {
    const client = raw as Client;
    const found = await client.query(
      `SELECT tenant_id, state, billing_mode, amount_cents, price_snapshot, kind, job_ref
         FROM credit_holds WHERE id=$1 FOR UPDATE`, [holdId]);
    if (!found.rowCount) throw new CatalogHttpError(404, `计费记录不存在：${holdId}`);
    const hold = found.rows[0] as {
      tenant_id: string; state: 'held' | 'settled' | 'released' | 'disputed';
      billing_mode: 'charge' | 'exempt'; amount_cents: string; price_snapshot: PriceSnapshot;
      kind: HoldKind; job_ref: string;
    };
    if (hold.tenant_id !== tenantId) throw new CatalogHttpError(403, '计费记录不属于当前账号');
    if (hold.state === 'settled' || hold.state === 'released') return { state: hold.state, alreadyResolved: true as const };

    let confirmedMicro = 0; let unknownMicro = 0;
    for (const attempt of attempts) {
      if (!attempt.billable) continue;
      const price = priceOf(hold.price_snapshot, attempt.action).userMicroCents;
      if (attempt.certain) confirmedMicro += price; else unknownMicro += price;
    }
    const confirmedCents = microToCents(confirmedMicro);
    // Rounded against the combined total so the two parts can never exceed the ceiling.
    const unknownCents = microToCents(confirmedMicro + unknownMicro) - confirmedCents;
    const amount = Number(hold.amount_cents);

    if (unknownMicro > 0) {
      // Never guess: an uncertain call stays frozen until a person decides.
      await client.query(
        `UPDATE credit_holds SET state='disputed', disputed_at=now(), confirmed_cents=$2, unknown_cents=$3
          WHERE id=$1 AND state='held'`, [holdId, confirmedCents, unknownCents]);
      await recordUsage(client, tenantId, attempts.filter(a => a.billable && a.certain));
      return { state: 'disputed' as const, confirmedCents, unknownCents };
    }

    const settled = Math.min(confirmedCents, amount);
    await applyResolution(client, { holdId, tenantId, hold, settled, confirmedCents, unknownCents: 0, reason: `结算：${hold.kind} ${hold.job_ref}` });
    await recordUsage(client, tenantId, attempts.filter(a => a.billable));
    return { state: settled === 0 ? 'released' as const : 'settled' as const, confirmedCents, unknownCents: 0 };
  });
}

/** Release everything without charging: the call provably never happened. */
export async function releaseHold(holdId: string, tenantId: string, reason = '未产生费用，全额退回') {
  return catalogTransaction(async raw => {
    const client = raw as Client;
    const found = await client.query(
      'SELECT tenant_id, state, billing_mode, amount_cents, kind, job_ref FROM credit_holds WHERE id=$1 FOR UPDATE', [holdId]);
    if (!found.rowCount) throw new CatalogHttpError(404, `计费记录不存在：${holdId}`);
    const hold = found.rows[0] as { tenant_id: string; state: string; billing_mode: 'charge' | 'exempt'; amount_cents: string; kind: HoldKind; job_ref: string };
    if (hold.tenant_id !== tenantId) throw new CatalogHttpError(403, '计费记录不属于当前账号');
    if (hold.state === 'settled' || hold.state === 'released') return { state: hold.state, alreadyResolved: true as const };
    await applyResolution(client, { holdId, tenantId, hold, settled: 0, confirmedCents: 0, unknownCents: 0, reason });
    return { state: 'released' as const };
  });
}

/** An operator's decision on a frozen, uncertain charge. Allowed from `held` or `disputed`. */
export async function adjudicateHold(holdId: string, tenantId: string, decision: 'charge' | 'refund', operatorId: string) {
  return catalogTransaction(async raw => {
    const client = raw as Client;
    const found = await client.query(
      'SELECT tenant_id, state, billing_mode, amount_cents, confirmed_cents, unknown_cents, kind, job_ref FROM credit_holds WHERE id=$1 FOR UPDATE', [holdId]);
    if (!found.rowCount) throw new CatalogHttpError(404, `计费记录不存在：${holdId}`);
    const hold = found.rows[0] as Record<string, string> & { state: string };
    if (hold.tenant_id !== tenantId) throw new CatalogHttpError(403, '计费记录不属于当前账号');
    if (hold.state === 'settled' || hold.state === 'released') return { state: hold.state, alreadyResolved: true as const };
    const confirmed = Number(hold.confirmed_cents ?? 0);
    const unknown = Number(hold.unknown_cents ?? 0);
    const settled = Math.min(decision === 'charge' ? confirmed + unknown : confirmed, Number(hold.amount_cents));
    await applyResolution(client, {
      holdId, tenantId,
      hold: hold as unknown as { billing_mode: 'charge' | 'exempt'; amount_cents: string; kind: HoldKind; job_ref: string },
      settled, confirmedCents: confirmed, unknownCents: unknown,
      reason: decision === 'charge' ? '人工裁定：确认收费' : '人工裁定：退回未知部分', operatorId,
    });
    return { state: settled === 0 ? 'released' as const : 'settled' as const, settledCents: settled };
  });
}

async function applyResolution(client: Client, input: {
  holdId: string; tenantId: string;
  hold: { billing_mode: 'charge' | 'exempt'; amount_cents: string; kind: HoldKind; job_ref: string };
  settled: number; confirmedCents: number; unknownCents: number; reason: string; operatorId?: string;
}) {
  const amount = Number(input.hold.amount_cents);
  const state = input.settled === 0 ? 'released' : 'settled';
  const moved = await client.query(
    `UPDATE credit_holds SET state=$2, settled_cents=$3, confirmed_cents=$4, unknown_cents=$5, resolved_at=now()
      WHERE id=$1 AND state IN ('held','disputed')`,
    [input.holdId, state, input.settled, input.confirmedCents, input.unknownCents]);
  if (!moved.rowCount) throw new CatalogHttpError(409, '计费记录状态已变化，请刷新后重试');

  if (input.hold.billing_mode === 'exempt' || amount === 0) return;
  // Release the whole hold, then charge back only what was actually used.
  const account = await client.query(
    `UPDATE credit_accounts
        SET held_cents = held_cents - $2, balance_cents = balance_cents + ($2 - $3), updated_at = now()
      WHERE tenant_id = $1 RETURNING balance_cents, held_cents`,
    [input.tenantId, amount, input.settled]);
  const row = account.rows[0] as { balance_cents: string; held_cents: string };
  await writeLedger(client, {
    tenantId: input.tenantId, kind: state === 'released' ? 'release' : 'settle',
    amountCents: state === 'released' ? amount : amount - input.settled,
    balanceAfter: Number(row.balance_cents), heldAfter: Number(row.held_cents),
    holdId: input.holdId, reason: input.reason, operatorId: input.operatorId,
  });
}

async function recordUsage(client: Client, tenantId: string, attempts: AttemptOutcome[]) {
  for (const attempt of attempts) {
    await client.query(
      `INSERT INTO usage_events(id,tenant_id,idempotency_key,metric_code,quantity,properties,occurred_at)
       VALUES ($1,$2,$3,$4,1,$5,now()) ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), tenantId, attempt.attemptId, attempt.action, attempt.properties ?? {}]);
  }
}

async function writeLedger(client: Client, entry: {
  tenantId: string; kind: 'grant' | 'hold' | 'settle' | 'release' | 'adjust';
  amountCents: number; balanceAfter: number; heldAfter: number;
  holdId?: string; reason: string; operatorId?: string; costEstimateCents?: number;
}) {
  await client.query(
    `INSERT INTO credit_ledger(id,tenant_id,kind,amount_cents,balance_after,held_after,hold_id,reason,operator_id,cost_estimate_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), entry.tenantId, entry.kind, entry.amountCents, entry.balanceAfter, entry.heldAfter,
      entry.holdId ?? null, entry.reason, entry.operatorId ?? null, entry.costEstimateCents ?? null]);
}

/** Operator tops a tenant up. Recorded with who did it and why; not reversible by itself. */
export async function grantCredits(tenantId: string, amountCents: number, reason: string, operatorId: string) {
  const amount = Math.trunc(amountCents);
  if (!Number.isSafeInteger(amount) || amount === 0) throw new CatalogHttpError(400, '发放数量必须是非零整数');
  if (!reason.trim()) throw new CatalogHttpError(400, '请填写发放原因');
  return catalogTransaction(async raw => {
    const client = raw as Client;
    const updated = await client.query(
      `UPDATE credit_accounts SET balance_cents = balance_cents + $2, updated_at = now()
        WHERE tenant_id = $1 AND balance_cents + $2 >= 0 RETURNING balance_cents, held_cents`,
      [tenantId, amount]);
    if (!updated.rowCount) throw new CatalogHttpError(409, '余额不足以扣减，或账号缺少积分账户');
    const row = updated.rows[0] as { balance_cents: string; held_cents: string };
    await writeLedger(client, {
      tenantId, kind: amount > 0 ? 'grant' : 'adjust', amountCents: amount,
      balanceAfter: Number(row.balance_cents), heldAfter: Number(row.held_cents),
      reason: reason.trim(), operatorId,
    });
    return { balanceCents: Number(row.balance_cents) };
  });
}

/**
 * Operator sets the spendable balance to an exact figure. The difference is written to the
 * ledger like any grant; credits frozen by running work are left alone and settle as usual.
 */
export async function setCreditBalance(tenantId: string, targetCents: number, reason: string, operatorId: string) {
  const target = Math.trunc(targetCents);
  if (!Number.isSafeInteger(target) || target < 0) throw new CatalogHttpError(400, '积分必须是不小于 0 的整数');
  if (!reason.trim()) throw new CatalogHttpError(400, '请填写调整原因');
  return catalogTransaction(async raw => {
    const client = raw as Client;
    const found = await client.query('SELECT balance_cents FROM credit_accounts WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
    if (!found.rowCount) throw new CatalogHttpError(404, '账号缺少积分账户');
    const delta = target - Number((found.rows[0] as { balance_cents: string }).balance_cents);
    if (delta === 0) return { balanceCents: target, deltaCents: 0 };
    const updated = await client.query(
      `UPDATE credit_accounts SET balance_cents = $2, updated_at = now() WHERE tenant_id = $1
        RETURNING balance_cents, held_cents`, [tenantId, target]);
    const row = updated.rows[0] as { balance_cents: string; held_cents: string };
    await writeLedger(client, {
      tenantId, kind: delta > 0 ? 'grant' : 'adjust', amountCents: delta,
      balanceAfter: Number(row.balance_cents), heldAfter: Number(row.held_cents),
      reason: reason.trim(), operatorId,
    });
    return { balanceCents: target, deltaCents: delta };
  });
}

export async function creditBalance(tenantId: string) {
  const found = await catalogDatabase().query(
    'SELECT balance_cents, held_cents FROM credit_accounts WHERE tenant_id=$1', [tenantId]);
  if (!found.rowCount) throw new CatalogHttpError(404, '账号缺少积分账户');
  const row = found.rows[0] as { balance_cents: string; held_cents: string };
  return { balanceCents: Number(row.balance_cents), heldCents: Number(row.held_cents) };
}

/** Holds nobody resolved. Their work is over, so the receipts decide the outcome. */
export async function openHolds(olderThanMinutes = 120, limit = 100) {
  const rows = await catalogDatabase().query(
    `SELECT id, tenant_id, kind, job_ref, amount_cents, state, created_at
       FROM credit_holds
      WHERE state IN ('held','disputed') AND created_at < now() - ($1 || ' minutes')::interval
      ORDER BY created_at LIMIT $2`, [String(olderThanMinutes), limit]);
  return rows.rows.map(row => ({
    id: row.id as string, tenantId: row.tenant_id as string, kind: row.kind as HoldKind,
    jobRef: row.job_ref as string, amountCents: Number(row.amount_cents),
    state: row.state as 'held' | 'disputed', createdAt: row.created_at as Date,
  }));
}
