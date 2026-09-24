import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
/** Retire the old auto-registration path, including already-open browser clients. */
export async function POST() {
  return NextResponse.json({ error: '登录方式已更新，请使用账号密码登录；没有账号请先用邮箱注册' }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
