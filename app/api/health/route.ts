import { NextResponse } from 'next/server';
import { catalogDatabase } from '@/lib/server/catalog-database';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const result = await catalogDatabase().query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
    // The oldest schema this code runs on. "At least", not "exactly": a data-only migration can then
    // be applied after the release that ships it, so the live site never reports unready in between.
    const ready = (result.rows[0]?.name ?? '') >= '025_pricing_v2.sql';
    return NextResponse.json({ ready, database: 'connected', migration: result.rows[0]?.name ?? null,
      release: process.env.WORKWEAR_BUILD_COMMIT ?? null }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ready: false, database: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
