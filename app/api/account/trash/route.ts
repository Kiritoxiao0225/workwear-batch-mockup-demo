import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogError, catalogJson } from '@/lib/server/catalog-http';
import { tenantScope } from '@/lib/server/tenant-scope';
import { listTrash, purgeTrashNow, restoreTrash, TRASH_DAYS } from '@/lib/server/listing-trash';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store' };

/** The account's 回收站: what was deleted in the last TRASH_DAYS days and can still be put back. */
export async function GET(request: NextRequest) {
  try {
    const { tenant } = await tenantScope(request);
    return NextResponse.json({ days: TRASH_DAYS, items: await listTrash(tenant.id) }, { headers });
  } catch (error) { return catalogError(error); }
}

const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('restore'), id: z.uuid() }),
  z.object({ action: z.literal('purge'), id: z.uuid() }),
  z.object({ action: z.literal('purge-all') }),
]);

export async function POST(request: NextRequest) {
  try {
    const { tenant } = await tenantScope(request, true);
    const body = input.parse(await catalogJson(request));
    if (body.action === 'restore') return NextResponse.json(await restoreTrash(tenant.id, body.id), { headers });
    return NextResponse.json(await purgeTrashNow(tenant.id, body.action === 'purge' ? body.id : 'all'), { headers });
  } catch (error) { return catalogError(error); }
}
