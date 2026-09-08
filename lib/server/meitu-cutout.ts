import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

type ApiResponse = { code?: number; error_code?: number; message?: string; data?: { task_id?: string; status?: number; result?: { parameters?: { result?: { submit_body?: { parameter?: { trace_id?: string } } } }; media_info_list?: Array<{ media_data: string }> }; records?: Array<{ listing_code: string; trace_id: string; status: string; credits: number }> } };
type MeituClient = {
  createImage: (payload: unknown, options?: unknown) => Promise<ApiResponse>;
  getTask: (task: string) => Promise<ApiResponse>;
  listAccountUsage: (options: unknown) => Promise<ApiResponse>;
  imageBaseUrl: () => string;
  baseUrl: () => string;
  strategyBaseUrl: () => string;
  resolveOpenApiAuth: () => Promise<unknown>;
  iamMtccUid: () => Promise<string>;
  mcpPassthroughState: (context: unknown) => Promise<Record<string, unknown>>;
};
// The official CLI has no public SDK entry. Pin its runtime and cover this adapter
// with transport contract tests; no shell execution or account-login fallback.
const require = createRequire(import.meta.url);
const runtimeDir = path.dirname(require.resolve(/* turbopackIgnore: true */ 'meitu-cli/workflow-help'));
// Keep SDK loading native: Turbopack cannot resolve runtime-computed require paths.
const apiPath = path.join(runtimeDir, 'api.js');
const uploadPath = path.join(runtimeDir, 'upload.js');
const { APIClient } = require(/* turbopackIgnore: true */ apiPath) as { APIClient: new () => MeituClient };
const { uploadLocalFile } = require(/* turbopackIgnore: true */ uploadPath) as { uploadLocalFile: (client: MeituClient, file: string) => Promise<string> };
export const MEITU_CUTOUT_VERSION = 'meitu-cli-2.1.21-intl-image-cutout-graphic-2';
// Supply the SDK's supported device identity explicitly. Serverless instances
// have no writable home directory; this identity needs no on-disk CLI session.
const instanceGnum = randomUUID();
export class MeituSubmissionNotStartedError extends Error {}
export function meituCutoutClient() {
  const accessKey = process.env.MEITU_OPENAPI_ACCESS_KEY, secretKey = process.env.MEITU_OPENAPI_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('美图海外抠图未配置 AK/SK');
  const client = new APIClient();
  client.imageBaseUrl = client.baseUrl = () => 'https://openapi.starii.com';
  client.strategyBaseUrl = () => 'https://strategy.stariidata.com';
  client.resolveOpenApiAuth = async () => ({ mode: 'signed', accessKey, secretKey, source: 'env', authMode: 'aksk' });
  client.iamMtccUid = async () => '';
  return client;
}
export async function uploadMeituCutoutInput(bytes: Buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wps-meitu-'));
  try { const file = path.join(dir, 'input.png'); await writeFile(file, bytes, { mode: 0o600 }); return await uploadLocalFile(meituCutoutClient(), file); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
export function meituCutoutPayload(imageUrl: string, requestId: string) {
  return { task: 'image-cutout', task_type: 'formula', params: JSON.stringify({ parameter: { model_type: 2 } }),
    init_images: [{ profile: { media_profiles: { media_data_type: 'url' }, version: 'v1' }, url: imageUrl }],
    request_id: requestId, trace_id: requestId, context: '', rsp_media_type: 'url' };
}
export async function submitMeituCutout(imageUrl: string, requestId: string) {
  const extraContext = {
    mtcc_client: { gnum: instanceGnum },
    function: { name: 'image-cutout', effect: 'skill_image-cutout' }, ext_info: { source: 'cli_command', listing_code: 'image-cutout' },
  };
  let client: MeituClient;
  try {
    client = meituCutoutClient();
    // Resolve local SDK context before entering the potentially paid request.
    const context = await client.mcpPassthroughState(extraContext);
    // The CLI otherwise replaces payload IDs with fresh random IDs. Keep the
    // durable job ID in both the signed headers and provider billing trace.
    client.mcpPassthroughState = async () => ({ ...context, requestId, traceId: requestId });
  } catch (error) {
    throw new MeituSubmissionNotStartedError(`美图抠图尚未提交：${error instanceof Error ? error.message : String(error)}`);
  }
  return client.createImage(meituCutoutPayload(imageUrl, requestId), { extraContext });
}
export async function queryMeituCutout(taskId: string) { return meituCutoutClient().getTask(taskId); }
export async function meituCutoutCredits(requestId: string) {
  try {
    const result = await meituCutoutClient().listAccountUsage({ page: 1, pageSize: 100, listingCode: 'image-cutout' });
    const entry = result.data?.records?.find(row => row.listing_code === 'image-cutout' && row.trace_id === requestId && row.status === 'consumed');
    return entry && Number.isFinite(entry.credits) ? entry.credits : null;
  } catch { return null; }
}
export async function downloadMeituCutout(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['meitudata.com', 'stariidata.com'].some(domain => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) throw new Error('美图返回了不受支持的结果地址');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`美图结果下载失败：${response.status}`);
  if (Number(response.headers.get('content-length')) > 25 * 1024 * 1024) throw new Error('美图结果超过 25MB');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error('美图结果超过 25MB');
  return bytes;
}
