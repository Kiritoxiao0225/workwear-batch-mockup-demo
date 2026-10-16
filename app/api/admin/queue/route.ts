import { NextRequest, NextResponse } from 'next/server';
import { catalogError } from '@/lib/server/catalog-http';
import { adminScope } from '@/lib/server/admin-guard';
import { externalQueueHealth, queueStuck } from '@/lib/server/queue-health';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Customers' queue at a glance for the admin page: waiting, running, and whether it is stuck. */
export async function GET(request: NextRequest) {
  try {
    await adminScope(request);
    const health = await externalQueueHealth();
    return NextResponse.json({ ...health, stuck: queueStuck(health) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return catalogError(error); }
}
