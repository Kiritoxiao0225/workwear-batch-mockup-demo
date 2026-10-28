import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { accountDetail, updateAccount } from '@/lib/server/admin-accounts';
import { APP_PAGES, type AppPage } from '@/lib/app-pages';
import { ARTWORK_ROUTES } from '@/lib/server/page-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const pageHrefs = APP_PAGES.map(page => page.href) as [AppPage, ...AppPage[]];
const input = z.object({
  note: z.string().max(500).optional(),
  // null restores the default set, so a later page added to the product reaches this account too.
  allowedPages: z.array(z.enum(pageHrefs)).max(pageHrefs.length).nullable().optional(),
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
  disabled: z.boolean().optional(),
  dailyCapCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  // null shows both routes on 图稿生成 and lets the account pick.
  artworkRoute: z.enum(ARTWORK_ROUTES).nullable().optional(),
  // Whole bytes, 100 MB to 10 TB.
  storageQuotaBytes: z.number().int().min(100 * 1024 ** 2).max(10 * 1024 ** 4).optional(),
}).strict();

export async function GET(request: NextRequest, context: Context) {
  try {
    await adminScope(request);
    const { id } = await context.params;
    return NextResponse.json(await accountDetail(z.uuid().parse(id)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { user } = await adminScope(request, true);
    const { id } = await context.params;
    const patch = input.parse(await catalogJson(request));
    return NextResponse.json(await updateAccount(z.uuid().parse(id), patch, user.id), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
