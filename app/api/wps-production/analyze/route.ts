import { NextResponse } from 'next/server';

import type { SourceTaskRecord } from '@/lib/batch-task-review';
import { analyzeSourceTaskRecords } from '@/lib/server/ark-task-review';
import { listWpsSourceTaskRecords } from '@/lib/server/wps-dbsheet';
import { canAnalyzeWpsTask, wpsSourceEvidence } from '@/lib/wps-source';
import { productionUser } from '@/lib/server/production-storage';
import { CatalogHttpError } from '@/lib/server/catalog-auth';

export const runtime = 'nodejs';
export const maxDuration = 180;

function parsedRecords(value: unknown): SourceTaskRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是对象');
  const records = (value as Record<string, unknown>).records;
  if (!Array.isArray(records) || records.length === 0) throw new Error('records 必须是非空数组');
  if (records.length > 30) throw new Error(`单次最多分析 30 条记录，实际 ${records.length}`);
  return records.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`records[${index}] 必须是对象`);
    const record = entry as Record<string, unknown>;
    for (const field of ['recordId', 'customerId', 'revision', 'requirementText', 'productStyleText']) {
      if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error(`records[${index}].${field} 必须是非空字符串`);
    }
    if (!Array.isArray(record.materials)) throw new Error(`records[${index}].materials 必须是数组`);
    return entry as SourceTaskRecord;
  });
}

export async function POST(request: Request) {
  try {
    await productionUser(request, true);
    const records = parsedRecords(await request.json());
    const { records: currentRecords } = await listWpsSourceTaskRecords();
    const currentById = new Map(currentRecords.map((record) => [record.recordId, record]));
    const verifiedRecords = records.map((record) => {
      const current = currentById.get(record.recordId);
      if (!current) throw new Error(`WPS_ANALYSIS_CONFLICT: 记录 ${record.recordId} 已不存在或读取失败，请重新同步`);
      if (!canAnalyzeWpsTask(current)) throw new Error(`WPS_ANALYSIS_CONFLICT: ${record.recordId} 当前状态为“${current.wpsSource?.status ?? '未识别状态'}”，仅允许分析待领取和设计中的任务`);
      if (wpsSourceEvidence(current) !== wpsSourceEvidence(record)) throw new Error(`WPS_ANALYSIS_CONFLICT: ${record.recordId} 原文或素材已变化，请重新同步后分析`);
      return current;
    });
    return NextResponse.json(await analyzeSourceTaskRecords(verifiedRecords));
  } catch (error) {
    if (error instanceof CatalogHttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : String(error);
    const configurationError = message.includes('is not configured') || message.startsWith('WPS_SYNC_NOT_CONFIGURED:') || message.startsWith('WPS_ANALYSIS_CONFIG_ERROR:');
    const inputError = message.startsWith('records') || message.startsWith('请求体') || message.startsWith('单次');
    return NextResponse.json({ error: message }, { status: message.startsWith('WPS_ANALYSIS_CONFLICT:') ? 409 : configurationError ? 503 : inputError ? 400 : 502 });
  }
}
