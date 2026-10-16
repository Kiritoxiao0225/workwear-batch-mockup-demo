import { NextResponse } from 'next/server';
import { catalogDatabase } from '@/lib/server/catalog-database';

export const dynamic = 'force-dynamic';

// Zeabur probes this every few seconds and takes the web service out of rotation when it times out.
// On 2026-10-15 a busy pool made the probe wait and users lost the site although the database was
// fine. A recent success is reused; only a database gone for over a minute reports unready.
const FRESH_MS = 15_000, TOLERATED_MS = 60_000, QUERY_MS = 3_000;
let last: { at: number; migration: string | null } | null = null;

async function latestMigration() {
  const query = catalogDatabase().query('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('health query timed out')), QUERY_MS); });
  try { return ((await Promise.race([query, timeout])).rows[0]?.name as string | undefined) ?? null; }
  finally { clearTimeout(timer); }
}

export async function GET() {
  const headers = { 'Cache-Control': 'no-store' };
  let stale = false;
  if (!last || Date.now() - last.at > FRESH_MS) {
    try { last = { at: Date.now(), migration: await latestMigration() }; }
    catch {
      if (!last || Date.now() - last.at > TOLERATED_MS) return NextResponse.json({ ready: false, database: 'unavailable' }, { status: 503, headers });
      stale = true;
    }
  }
  // The oldest schema this code runs on. "At least", not "exactly": a data-only migration can then
  // be applied after the release that ships it, so the live site never reports unready in between.
  const ready = (last.migration ?? '') >= '025_pricing_v2.sql';
  return NextResponse.json({ ready, database: stale ? 'slow' : 'connected', migration: last.migration,
    release: process.env.WORKWEAR_BUILD_COMMIT ?? null }, { status: ready ? 200 : 503, headers });
}
