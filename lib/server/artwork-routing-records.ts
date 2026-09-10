import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTWORK_ROUTING_STANDARD, type ArtworkRoutingReport } from '@/lib/artwork-routing-standard';
import { catalogDatabase } from './catalog-database';
import { productionStateKey, usesProductionCloud } from './production-storage';
import { saveCatalogFile } from './catalog-files';

const root = () => path.join(process.cwd(), 'data', 'artwork-runs');
function id(value: string) {
  if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error('图案处理记录 ID 无效');
  return value;
}
async function saveCloudRecord(runId: string, kind: string, record: unknown) {
  await catalogDatabase().query('INSERT INTO artwork_run_records(state_key,run_id,kind,record_json) VALUES($1,$2,$3,$4::jsonb)',
    [productionStateKey(), id(runId), kind, record]);
}
export async function saveArtworkRunImage(runId: string, label: string, bytes: Buffer) {
  if (!/^[a-z0-9-]+$/u.test(label)) throw new Error('图案处理记录图名无效');
  id(runId);
  if (usesProductionCloud()) {
    // Audit images stay outside the replaceable production object prefix.
    const file = await saveCatalogFile(bytes, `${runId}-${label}.png`);
    await saveCloudRecord(runId, `image:${label}`, { fileId: file.id, sha256: file.sha256 });
    return;
  }
  await mkdir(root(), { recursive: true });
  await writeFile(path.join(root(), `${id(runId)}-${label}.png`), bytes, { flag: 'wx' });
}
export async function saveArtworkRoutingReport(report: ArtworkRoutingReport) {
  if (usesProductionCloud()) return saveCloudRecord(report.runId, 'report', report);
  await mkdir(root(), { recursive: true });
  await writeFile(path.join(root(), `${id(report.runId)}.json`), JSON.stringify(report, null, 2), { flag: 'wx' });
}
export async function saveArtworkGenerationReceipt(runId: string, receipt: Record<string, unknown>) {
  if (usesProductionCloud()) return saveCloudRecord(runId, 'generation', receipt);
  await mkdir(root(), { recursive: true });
  await writeFile(path.join(root(), `${id(runId)}-generation.json`), JSON.stringify(receipt, null, 2), { flag: 'wx' });
}
export async function readArtworkRoutingReport(runId: string): Promise<ArtworkRoutingReport> {
  id(runId);
  const report = (usesProductionCloud()
    ? (await catalogDatabase().query("SELECT record_json FROM artwork_run_records WHERE state_key=$1 AND run_id=$2 AND kind='report'", [productionStateKey(), runId])).rows[0]?.record_json
    : JSON.parse(await readFile(path.join(root(), `${runId}.json`), 'utf8'))) as ArtworkRoutingReport | undefined;
  if (!report || ![ARTWORK_ROUTING_STANDARD.version, 'artwork-routing-v2'].includes(report.version) || report.runId !== runId || !report.graphic?.sha256) throw new Error('图案处理记录不完整或版本不匹配');
  return report;
}
