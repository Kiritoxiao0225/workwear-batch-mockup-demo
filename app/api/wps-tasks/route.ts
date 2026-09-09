import { NextResponse } from 'next/server';
import { productionUser } from '@/lib/server/production-storage';
import { catalogError } from '@/lib/server/catalog-http';

import {
  listWpsSourceTaskRecords,
  wpsConfigurationStatus,
} from '@/lib/server/wps-dbsheet';

export const runtime = 'nodejs';

export async function GET(request?: Request) {
  try { await productionUser(request); } catch (error) { return catalogError(error); }
  const status = wpsConfigurationStatus();
  if (!status.configured) {
    const labels: Record<string, string> = { WPS_AIRSCRIPT_WEBHOOK: '脚本 Webhook 链接', WPS_AIRSCRIPT_TOKEN: '脚本令牌', WPS_SOURCE_URL: '原表链接', WPS_DBSHEET_FILE_ID: '原表文件 ID' };
    return NextResponse.json({
      error: status.mode === 'airscript' ? `原表连接尚缺少：${status.missing.map((name) => labels[name] ?? name).join('、')}。请按接入步骤补充。` : `WPS 实时同步未配置：缺少 ${status.missing.join(', ')}`,
      setupUrl: '/wps-connect',
      configured: false,
      missingEnvironment: status.missing,
    }, { status: 503 });
  }
  try {
    const sync = await listWpsSourceTaskRecords({ activeOnly: true, downloadMaterials: false });
    return NextResponse.json({
      mode: 'live',
      scope: 'active',
      sourceType: 'dbsheet',
      connectionMode: status.mode,
      configured: true,
      missingEnvironment: [],
      sourceUrl: process.env.WPS_SOURCE_URL?.trim() || 'https://365.kdocs.cn/view/l/cj5Qvp0WVtjz',
      records: sync.records,
      reviews: null,
      syncedAt: sync.syncedAt,
      sourceFile: {
        fileId: sync.source.fileId,
        fileName: sync.source.fileName,
        fileType: sync.source.fileType,
        version: sync.source.version,
      },
      cacheHit: sync.cacheHit,
      issues: sync.issues,
      totalRecords: sync.totalRecords,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('WPS_USER_AUTH_REQUIRED:')) {
      return NextResponse.json({
        error: message.replace('WPS_USER_AUTH_REQUIRED:', '').trim(),
        authorizeUrl: '/api/wps/oauth/start',
      }, { status: 401 });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
