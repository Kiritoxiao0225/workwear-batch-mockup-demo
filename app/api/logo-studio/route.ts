import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Image generation now runs through the shared production queue, so this synchronous
// provider path is retired. See the artwork studio entry point instead.
export const POST = () => NextResponse.json(
  { error: '该接口已停用，请使用图稿生成', code: 'LEGACY_LOGO_STUDIO_RETIRED' },
  { status: 410, headers: { 'Cache-Control': 'no-store' } });
