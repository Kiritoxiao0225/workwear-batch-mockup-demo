import { NextRequest, NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { tenantScope } from '@/lib/server/tenant-scope';
import { creditBalance } from '@/lib/server/credits';
import { tenantUsage } from '@/lib/server/quota';
import { catalogDatabase } from '@/lib/server/catalog-database';
import { userPages } from '@/lib/server/page-access';
import { impersonator } from '@/lib/server/impersonation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Balance, quota and recent ledger for the signed-in account. Credits only, never cost. */
export async function GET(request: NextRequest) {
  try {
    const { user, tenant } = await tenantScope(request);
    const [balance, usage, ledger, disputed, credentials, pages, enteredBy] = await Promise.all([
      creditBalance(tenant.id),
      tenantUsage(tenant.id),
      catalogDatabase().query(
        `SELECT kind, amount_cents, balance_after, reason, created_at
           FROM credit_ledger WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50`, [tenant.id]),
      catalogDatabase().query(
        `SELECT id, job_ref, amount_cents, confirmed_cents, unknown_cents, disputed_at
           FROM credit_holds WHERE tenant_id=$1 AND state='disputed' ORDER BY disputed_at DESC`, [tenant.id]),
      catalogDatabase().query('SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id=$1', [user.id]),
      userPages(user.id),
      impersonator(request),
    ]);
    return NextResponse.json({
      user: { displayName: user.displayName, role: user.role, email: user.email, hasPassword: Boolean(credentials.rows[0]?.has_password) },
      tenant: { name: tenant.name, plan: tenant.plan, internal: tenant.workspace === 'main' },
      pages,
      // Set while an administrator is looking at this account from the admin console.
      enteredBy,
      balance,
      quota: usage,
      ledger: ledger.rows.map(row => ({
        kind: row.kind, amountCents: Number(row.amount_cents), balanceAfter: Number(row.balance_after),
        reason: row.reason, createdAt: (row.created_at as Date).toISOString(),
      })),
      // Frozen and waiting on a person: never auto-refunded, never auto-charged.
      disputed: disputed.rows.map(row => ({
        id: row.id, jobRef: row.job_ref, amountCents: Number(row.amount_cents),
        confirmedCents: Number(row.confirmed_cents ?? 0), unknownCents: Number(row.unknown_cents ?? 0),
        disputedAt: (row.disputed_at as Date).toISOString(),
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
