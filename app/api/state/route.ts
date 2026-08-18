import { NextResponse } from 'next/server';

import { readDemoState, writeDemoState } from '@/lib/server/demo-state-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await readDemoState(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `读取 Demo 状态失败：${message}` }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body: unknown = await request.json();
    return NextResponse.json(await writeDemoState(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `保存 Demo 状态失败：${message}` }, { status: 400 });
  }
}
