import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// The old shared demo state was readable and writable without any account. It is replaced by
// per-tenant workspaces; the stored JSON is left on disk untouched for reference.
const retired = () => NextResponse.json(
  { error: '旧版演示状态已停用，请使用新版批量生成', code: 'LEGACY_STATE_RETIRED' },
  { status: 410, headers: { 'Cache-Control': 'no-store' } });

export const GET = retired;
export const PUT = retired;
export const POST = retired;
