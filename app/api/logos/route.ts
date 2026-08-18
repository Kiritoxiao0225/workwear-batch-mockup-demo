import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少 Logo 文件' }, { status: 400 });
    }
    const extension = EXTENSION_BY_TYPE[file.type];
    if (!extension) {
      return NextResponse.json({ error: `不支持的 Logo 类型：${file.type || '未知'}` }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_LOGO_BYTES) {
      return NextResponse.json({ error: `Logo 大小必须在 1B 到 8MB 之间，实际：${file.size}B` }, { status: 400 });
    }
    const fileName = `${Date.now()}-${randomUUID()}.${extension}`;
    const uploadDirectory = path.join(process.cwd(), 'public', 'uploads', 'logos');
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(path.join(uploadDirectory, fileName), Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({
      url: `/uploads/logos/${fileName}`,
      originalName: file.name,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `上传 Logo 失败：${message}` }, { status: 500 });
  }
}
