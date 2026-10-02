import { NextRequest, NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { listAccounts } from '@/lib/server/admin-accounts';
import { openHolds } from '@/lib/server/credits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DAY = 24 * 60 * 60 * 1000;

/** Every registered account with its balance and what it spent, per page, in the range. */
export async function GET(request: NextRequest) {
  try {
    const { user } = await adminScope(request);
    const params = request.nextUrl.searchParams;
    const to = params.get('to') ? new Date(params.get('to')!) : new Date();
    const from = params.get('from') ? new Date(params.get('from')!) : new Date(to.getTime() - 30 * DAY);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new CatalogHttpError(400, '时间范围无效');
    const [accounts, holds] = await Promise.all([listAccounts({ from, to }), openHolds(0, 200)]);
    return NextResponse.json({
      self: user.id,
      range: { from: from.toISOString(), to: to.toISOString() },
      accounts,
      // Frozen and undecided: these are the ones a person has to rule on.
      disputes: holds.filter(hold => hold.state === 'disputed'),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
