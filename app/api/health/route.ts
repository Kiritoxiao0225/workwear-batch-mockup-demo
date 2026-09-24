import { NextResponse } from 'next/server';
import { catalogDatabase } from '@/lib/server/catalog-database';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const result = await catalogDatabase().query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
    const ready = result.rows[0]?.name === '023_garment_mockup.sql';
    return NextResponse.json({ ready, database: 'connected', migration: result.rows[0]?.name ?? null,
      release: process.env.WORKWEAR_BUILD_COMMIT ?? null }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ready: false, database: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
