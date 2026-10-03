import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogDatabase, catalogTransaction } from '@/lib/server/catalog-database';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ACTIONS = ['analyze', 'generate', 'enhance', 'cutout', 'cutout_standard', 'back_reference', 'recognize', 'listing_plan'] as const;

/** Current price per action and how often each was billed in the last 30 days. */
export async function GET(request: NextRequest) {
  try {
    await adminScope(request);
    const [prices, usage] = await Promise.all([
      catalogDatabase().query(
        `SELECT DISTINCT ON (action) action, cost_micro_cents, multiplier_milli, effective_from
           FROM price_list WHERE effective_from <= now() ORDER BY action, effective_from DESC`),
      catalogDatabase().query(
        `SELECT metric_code, count(*)::int AS n FROM usage_events
          WHERE occurred_at > now() - interval '30 days' GROUP BY metric_code`),
    ]);
    const counts = new Map(usage.rows.map(row => [row.metric_code as string, Number(row.n)]));
    return NextResponse.json({
      prices: prices.rows.map(row => ({
        action: row.action as string,
        costMicroCents: Number(row.cost_micro_cents),
        multiplierMilli: Number(row.multiplier_milli),
        effectiveFrom: (row.effective_from as Date).toISOString(),
        uses30d: counts.get(row.action as string) ?? 0,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}

const input = z.object({
  costs: z.record(z.enum(ACTIONS), z.number().int().min(0).max(10_000_000)),
  multiplierMilli: z.number().int().min(1000).max(10_000),
}).strict();

/**
 * Publish a new price for every action at once, effective immediately. Rows are versioned:
 * work already reserved keeps the snapshot it was quoted, so history never changes.
 */
export async function POST(request: NextRequest) {
  try {
    await adminScope(request, true);
    const body = input.parse(await catalogJson(request));
    const missing = ACTIONS.filter(action => body.costs[action] === undefined);
    if (missing.length) throw new CatalogHttpError(400, `缺少这些动作的成本：${missing.join('、')}`);
    await catalogTransaction(async client => {
      for (const action of ACTIONS) {
        await client.query('INSERT INTO price_list(action, cost_micro_cents, multiplier_milli) VALUES ($1, $2, $3)',
          [action, body.costs[action], body.multiplierMilli]);
      }
    });
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
