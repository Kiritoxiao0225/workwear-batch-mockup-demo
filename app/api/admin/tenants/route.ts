import { NextRequest, NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { catalogDatabase } from '@/lib/server/catalog-database';
import { openHolds } from '@/lib/server/credits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    await adminScope(request);
    const [tenants, disputes] = await Promise.all([
      catalogDatabase().query(
        `SELECT t.id, t.name, t.plan, t.billing_mode, t.disabled, t.workspace, t.created_at,
                t.style_quota, t.storage_quota_bytes,
                u.style_count, u.bytes_used,
                c.balance_cents, c.held_cents,
                (SELECT count(*)::int FROM users us WHERE us.tenant_id = t.id) AS member_count,
                COALESCE((SELECT sum(-l.amount_cents) FROM credit_ledger l
                           WHERE l.tenant_id = t.id AND l.kind = 'settle'
                             AND l.created_at > now() - interval '30 days'), 0) AS spent_30d
           FROM tenants t
           LEFT JOIN tenant_usage u ON u.tenant_id = t.id
           LEFT JOIN credit_accounts c ON c.tenant_id = t.id
          ORDER BY t.created_at`),
      openHolds(0, 200),
    ]);
    return NextResponse.json({
      tenants: tenants.rows.map(row => ({
        id: row.id, name: row.name, plan: row.plan, billingMode: row.billing_mode,
        disabled: row.disabled, workspace: row.workspace,
        createdAt: (row.created_at as Date).toISOString(),
        styleCount: Number(row.style_count ?? 0), styleQuota: Number(row.style_quota),
        bytesUsed: Number(row.bytes_used ?? 0), storageQuotaBytes: Number(row.storage_quota_bytes),
        balanceCents: Number(row.balance_cents ?? 0), heldCents: Number(row.held_cents ?? 0),
        memberCount: Number(row.member_count), spent30dCents: Number(row.spent_30d),
      })),
      // Frozen and undecided: these are the ones a person has to rule on.
      disputes: disputes.filter(hold => hold.state === 'disputed'),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
