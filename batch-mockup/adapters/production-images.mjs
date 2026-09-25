import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { saveJSON, atomicFile, checkpoint } from './a-files.mjs';
import { evolinkGenerate, evolinkKey, costRates } from './evolink.mjs';

const repo = process.cwd();
const GENERATION = {
  cliproxy: { provider: 'cliproxy', model: 'gpt-image-2', size: 'auto', quality: 'medium', background: 'auto', output_format: 'png', response_format: 'b64_json', n: 1 },
  // Sunburst returns the transparent artwork directly and only receives the images the artwork uses.
  evolink: { provider: 'evolink', model: 'gpt-image-2.5-sunburst', size: 'auto', quality: 'medium', background: 'transparent', output_format: 'png', n: 1, references: 'artwork' },
};
export const productionPolicyFor = (env = process.env) => ({ version: 1, generation: GENERATION[env.ARTWORK_IMAGE_PROVIDER === 'evolink' ? 'evolink' : 'cliproxy'], enhancement: { provider: 'mediakit', tool_version: 'standard', multiple: 2 }, cutout: { provider: 'meitu', command: 'image-cutout', model_type: 2 } });
export const productionPolicy = productionPolicyFor();
export async function inspectPixels(bytes) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0, visible = 0, edge = 0, clearEdge = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const a = data[(y * info.width + x) * info.channels + info.channels - 1];
    if (a < 8) transparent++; else visible++;
    if (!x || !y || x === info.width - 1 || y === info.height - 1) { edge++; if (a < 8) clearEdge++; }
  }
  return { width: info.width, height: info.height, transparentPixels: transparent, visiblePixels: visible,
    transparentRatio: transparent / (info.width * info.height), clearEdgeRatio: clearEdge / edge,
    transparentExterior: visible > 0 && transparent / (info.width * info.height) > 0.01 && clearEdge / edge >= 0.95 };
}
// Cutout and editing can leave isolated, nearly invisible pixels (one sat in the corner of a
// 1254 px artwork at alpha 20); trimming counts them and pushes the logo off center on the
// garment. Detached pieces that are both faint and tiny are cleared. Soft glows and shadows
// are larger or touch the design and stay; the size never changes, so repair still aligns
// the result with its pre-cutout original.
const SPECK_ALPHA = 64, SPECK_AREA = 1 / 2000;
export function clearFaintSpecks(data, width, height, channels = 4) {
  const n = width * height, limit = Math.max(16, n * SPECK_AREA), seen = new Uint8Array(n), stack = new Int32Array(n);
  const alpha = p => data[p * channels + channels - 1];
  let cleared = 0;
  for (let start = 0; start < n; start++) {
    if (seen[start] || alpha(start) < 8) continue;
    const piece = []; let top = 0, strongest = 0;
    seen[start] = 1; stack[top++] = start;
    while (top) {
      const p = stack[--top], x = p % width, y = (p - x) / width;
      strongest = Math.max(strongest, alpha(p)); if (piece.length <= limit) piece.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, q = ny * width + nx;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && !seen[q] && alpha(q) >= 8) { seen[q] = 1; stack[top++] = q; }
      }
    }
    if (strongest < SPECK_ALPHA && piece.length <= limit) { for (const p of piece) data[p * channels + channels - 1] = 0; cleared += piece.length; }
  }
  return cleared;
}
/** PNG bytes without faint specks; unchanged bytes when there are none or the image has no alpha. */
export async function withoutFaintSpecks(bytes) {
  const image = sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' });
  if (!(await image.metadata()).hasAlpha) return bytes;
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return clearFaintSpecks(data, info.width, info.height, info.channels) ? sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer() : bytes;
}
// A generator that returns transparency itself decides what counts as background, and it
// reads white fills inside a logo as partly background (a white shield came back 39% see-through).
// Semi-transparent pixels that the exterior cannot reach are made solid; soft edges and glows
// connected to the outside, and fully clear holes (deliberate knock-outs), stay as they are.
export async function hardenInteriorAlpha(bytes) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h, alpha = i => data[i * 4 + 3];
  const outside = new Uint8Array(n), queue = new Uint32Array(n); let end = 0;
  const reach = i => { if (!outside[i] && alpha(i) < 128) { outside[i] = 1; queue[end++] = i; } };
  for (let x = 0; x < w; x++) { reach(x); reach((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { reach(y * w); reach(y * w + w - 1); }
  for (let head = 0; head < end; head++) {
    const i = queue[head], x = i % w;
    if (x > 0) reach(i - 1); if (x < w - 1) reach(i + 1); if (i >= w) reach(i - w); if (i < n - w) reach(i + w);
  }
  let hardened = 0, visible = 0, soft = 0;
  for (let i = 0; i < n; i++) {
    if (!outside[i] && alpha(i) >= 8 && alpha(i) < 255) { data[i * 4 + 3] = 255; hardened++; }
    if (alpha(i) >= 8) { visible++; if (alpha(i) < 248) soft++; }
  }
  return { bytes: hardened ? await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer() : bytes, hardenedRatio: hardened / n, softRatio: visible ? soft / visible : 0 };
}
/** Opaque copy on white: the "before cut-out" source that fill and keep strokes restore from. */
export const flattenOnWhite = bytes => sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' }).flatten({ background: '#ffffff' }).png().toBuffer();
export async function configuredProduction() {
  const e = process.env.A_ANALYSIS_ENV_FILE ? { ...parseEnv(await readFile(process.env.A_ANALYSIS_ENV_FILE, 'utf8')), ...process.env } : process.env;
  const provider = e.ARTWORK_IMAGE_PROVIDER;
  if (provider === 'evolink') evolinkKey(e);
  else if (provider !== 'cliproxy' || !e.CLIPROXY_API_KEY) throw new Error('当前生图配置不是已选CLIProxy或EvoLink，未调用其他供应商');
  const base = provider === 'cliproxy' ? new URL(e.CLIPROXY_API_BASE_URL) : null;
  if (base && (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/u, '') !== '/v1')) throw new Error('生图接口配置无效');
  const rates = costRates(e);
  const secrets = ['CLIPROXY_API_KEY','EVOLINK_API_KEY','MEDIAKIT_API_KEY','MEITU_OPENAPI_ACCESS_KEY','MEITU_OPENAPI_SECRET_KEY'].map(k => e[k]).filter(Boolean);
  const scrub = s => secrets.reduce((s, key) => s.split(key).join('[REDACTED]'), String(s));
  const record = async (dir, name, value) => { await atomicFile(resolve(dir, name), scrub(value)); await checkpoint(); };
  async function download(url) {
    const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password) throw new Error('供应商返回的下载地址无效');
    const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`结果下载HTTP ${r.status}；原回执已保留，不重新制作`);
    return Buffer.from(await r.arrayBuffer());
  }
  async function generate(input, dir) {
    if (provider === 'evolink') return evolinkGenerate(input, dir, { env: e });
    const options = { ...GENERATION.cliproxy }; delete options.provider;
    if(input.transparentBackground===true)options.background='transparent';
    const images = input.images; if (images.length > 16) throw new Error('素材超过接口支持的16张，未丢图或改编号');
    let body; const headers = { Authorization: `Bearer ${e.CLIPROXY_API_KEY}` };
    if (images.length) {
      const f = new FormData(); Object.entries(options).forEach(([k,v]) => f.set(k, String(v))); f.set('prompt', input.prompt);
      for (const i of images) {
        const bytes = await readFile(i.path); const m = await sharp(bytes).metadata();
        f.append('image[]', new Blob([bytes], { type: `image/${m.format}` }), `image-${i.index}.${m.format}`);
      } body = f;
    } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify({ ...options, prompt: input.prompt }); }
    await saveJSON(resolve(dir, 'request.json'), { endpoint: '/images/' + (images.length ? 'edits' : 'generations'), ...options, prompt: input.prompt, images: images.map(i => ({ id:i.id,index:i.index,sha256:i.sha256,bytes:i.bytes,asset:i.asset })) });
    const r = await fetch(base.href.replace(/\/$/u,'')+'/images/'+(images.length?'edits':'generations'), { method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(600000) });
    const raw = await r.text(); await record(dir,'response.json',raw);
    await saveJSON(resolve(dir,'http.json'),{status:r.status,requestId:r.headers.get('x-request-id')});
    if (!r.ok) throw Object.assign(new Error(`生图接口HTTP ${r.status}；没有自动重试`), { definiteFailure:r.status>=400&&r.status<500 });
    const result=JSON.parse(raw); if(result.data?.length!==1||typeof result.data[0].b64_json!=='string') throw new Error('生图返回不完整；回执已保存，没有自动重试');
    return { bytes: Buffer.from(result.data[0].b64_json,'base64'), cost: { provider: 'codex', cny: 0, method: 'subscription' } };
  }
  async function enhance(input, dir) {
    if(!e.MEDIAKIT_API_KEY) throw new Error('火山高清凭据未配置');
    async function post(path,body,label) {
      const r=await fetch('https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/'+path,{method:'POST',headers:{Authorization:'Bearer '+e.MEDIAKIT_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
      const text=await r.text();await record(dir,label+'-response.json',text);const j=JSON.parse(text);
      if(!r.ok||j.success!==true||!j.result)throw Object.assign(new Error(`火山高清${label}返回HTTP ${r.status}，code=${j.code??'unknown'}`),{definiteFailure:r.status>=400&&r.status<500});return j.result;
    }
    const ticket=await post('request-media-upload-url',{},'upload');
    const bytes=await readFile(input.path),m=await sharp(bytes).metadata();
    const up=await fetch(ticket.upload_url,{method:'PUT',headers:{...Object.fromEntries((ticket.upload_headers||[]).map(h=>[h.key||h.name,h.value])),'Content-Type':`image/${m.format}`},body:bytes,signal:AbortSignal.timeout(120000)});
    if(!up.ok)throw new Error('高清素材上传失败，HTTP '+up.status);
    const body={image_url:ticket.file_id,tool_version:'standard',multiple:2};await saveJSON(resolve(dir,'request.json'),body);
    const result=await post('enhance-image',body,'enhance');await saveJSON(resolve(dir,'receipt.json'),result);
    return { bytes: await download(result.image_url), cost: { provider: 'mediakit', cny: rates.mediakitEnhance, method: 'unit_price' } };
  }
  async function cutout(path,dir) {
    if(!e.MEITU_OPENAPI_ACCESS_KEY||!e.MEITU_OPENAPI_SECRET_KEY)throw new Error('美图凭据未配置');
    const env={...process.env,MEITU_OPENAPI_ACCESS_KEY:e.MEITU_OPENAPI_ACCESS_KEY,MEITU_OPENAPI_SECRET_KEY:e.MEITU_OPENAPI_SECRET_KEY,MEITU_OPENAPI_TOOL_TASK_MODE:'command',MEITU_OPENAPI_TASK_TIMEOUT_MS:'900000',MEITU_CLI_PARTITION:'intl'};
    const args=['node_modules/meitu-cli/bin/meitu.js','image-cutout','--image_url',path,'--model_type','2','--json'];
    await saveJSON(resolve(dir,'request.json'),{command:'meitu image-cutout',image:path,model_type:2,partition:'intl'});
    async function cli(args,label) {
      const result=await new Promise((done,fail)=>{const p=spawn(process.execPath,args,{cwd:repo,env});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',fail);p.on('close',code=>done({code,stdout,stderr}));});
      await record(dir,label+'-stdout.json',result.stdout);await record(dir,label+'-stderr.txt',result.stderr);return result;
    }
    let result=await cli(args,'submit');
    const timeout=result.stderr.match(/task wait timeout:\s*([\w-]+)/u);
    if(timeout){await saveJSON(resolve(dir,'task.json'),{taskId:timeout[1]});result=await cli(['node_modules/meitu-cli/bin/meitu.js','task','wait',timeout[1],'--interval-ms','2000','--timeout-ms','900000','--json'],'wait');}
    let j;try{j=JSON.parse(result.stdout);}catch{throw new Error('美图返回不完整：'+scrub(result.stderr).slice(0,250));}
    await saveJSON(resolve(dir,'receipt.json'),j);
    if(!j.ok||!j.media_urls?.[0])throw Object.assign(new Error('美图未成功：'+scrub(j.message||j.hint||j.code)),{definiteFailure:j.ok===false});
    return { bytes: await download(j.media_urls[0]), cost: { provider: 'meitu', cny: rates.meituCutout, method: 'unit_price' } };
  }
  return { generate,enhance,cutout };
}
