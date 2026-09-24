import sharp from 'sharp';
import { requireArkApiKey } from '../garment-editor/ark-runtime';
import { normalizeMockupBase64Image, readMockupRemoteImage } from '../garment-editor/mockup-image-limits';
import { signVolcengineRequest } from '../garment-editor/mockup-volcengine-sign';
import { parseLogoRedrawGenerateRequest, type LogoRedrawAnalysis } from '../garment-editor/mockup-logo-redraw';
import { understandMockupLogoRedraw, generateMockupLogoRedraw } from './ark-garment-logo-redraw';

// Same request models as the CatalogHub editor. Independent of the batch/studio defaults.
export const GARMENT_MODELS = {
  understand: { provider: 'ark', model: 'doubao-seed-2-0-lite-260215' },
  generate: { provider: 'ark', model: 'doubao-seedream-4-0-250828' },
  back: { provider: 'ark', model: 'doubao-seedream-5-0-260128' },
  cutout: { provider: 'volcengine-cv', model: 'saliency_seg' },
} as const;
export type GarmentAction = keyof typeof GARMENT_MODELS;
export function assertGarmentProviderConfigured(action: GarmentAction, env: Record<string,string|undefined> = process.env) {
  if (action !== 'cutout') { requireArkApiKey(env); return; }
  if (!env.VOLCENGINE_ACCESS_KEY || !env.VOLCENGINE_SECRET_KEY)
    throw new Error('成衣抠图缺少火山配置：VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY；未提交抠图');
}
type Input = { instruction: string; images: {fileName:string;base64Image:string}[]; base64Image?:string; analysis?:unknown; confirmed?:boolean };
type Result = { analysis: LogoRedrawAnalysis; model: string } | { bytes: Buffer; model: string } | { bytes: Buffer; mask: Buffer; original: Buffer; model: string };
type Options = { env?: Record<string,string|undefined>; fetchImplementation?: typeof fetch; beforeSubmit:()=>Promise<void>; receipt:(id:string)=>Promise<void> };
export async function callGarmentModel(action: GarmentAction, input: Input, options: Options): Promise<Result> {
  const env=options.env??process.env, transport=options.fetchImplementation??fetch;
  assertGarmentProviderConfigured(action,env);
  const paidFetch:typeof fetch=async(url,init)=>{
    await options.beforeSubmit();
    const response=await transport(url,{...init,redirect:'error'});
    const id=response.headers.get('x-request-id');if(id)await options.receipt(id);
    return response;
  };
  const model=GARMENT_MODELS[action].model;
  const copiedOptions={env:{...env,MOCKUP_LOGO_ANALYSIS_MODEL:GARMENT_MODELS.understand.model,MOCKUP_LOGO_GENERATION_MODEL:GARMENT_MODELS.generate.model},
    fetchImplementation:((url,init)=>String(url).startsWith('https://ark.cn-beijing.volces.com/api/v3/')?paidFetch(url,init):transport(url,{...init,redirect:'error'})) as typeof fetch};
  if(action==='understand')return understandMockupLogoRedraw(input,copiedOptions);
  if(action==='generate'){
    const result=await generateMockupLogoRedraw(parseLogoRedrawGenerateRequest(input),copiedOptions);
    return {bytes:Buffer.from(result.image.dataUrl.split(',')[1],'base64'),model:result.image.model};
  }
  const original=normalizeMockupBase64Image(input.base64Image);
  if(action==='back'){
    const response=await paidFetch('https://ark.cn-beijing.volces.com/api/v3/images/generations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${requireArkApiKey(env)}`},signal:AbortSignal.timeout(60000),body:JSON.stringify({model,
      prompt:'服装背面视图，展开平铺放置，白色纯色背景，产品摄影风格，高清图像，与正面款式完全相同的服装背面，保持相同颜色和材质',
      image:original.dataUrl,response_format:'url',size:'1920x1920',stream:false,watermark:false})});
    if(!response.ok)throw new Error(`背面生成返回 HTTP ${response.status}，未自动重试`);
    const body=await response.json(),url=new URL(body.data?.[0]?.url);
    if(url.protocol!=='https:'||url.username||url.password)throw new Error('背面生成未返回有效图片地址');
    const image=await transport(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!image.ok)throw new Error('背面图片下载失败，未重新生成');
    const bytes=await sharp(Buffer.from(await readMockupRemoteImage(image))).png().toBuffer();
    return {bytes,model};
  }
  const source=Buffer.from(original.base64Data,'base64');
  const result=await volcengineSaliencyCutout(source,{env,fetchImplementation:paidFetch,receipt:options.receipt});
  return {...result,model};
}
type SaliencyOptions = { env?: Record<string,string|undefined>; fetchImplementation:typeof fetch; receipt:(id:string)=>Promise<void>; timeoutMs?:number };
/** One paid saliency_seg call. The caller's fetch marks the submission; nothing retries here. */
export async function volcengineSaliencyCutout(source: Buffer, options: SaliencyOptions) {
  const env=options.env??process.env;
  if (!env.VOLCENGINE_ACCESS_KEY || !env.VOLCENGINE_SECRET_KEY)
    throw new Error('成衣抠图缺少火山配置：VOLCENGINE_ACCESS_KEY / VOLCENGINE_SECRET_KEY；未提交抠图');
  const body=JSON.stringify({req_key:'saliency_seg',binary_data_base64:[source.toString('base64')],only_mask:1,refine_mask:1});
  const host='visual.volcengineapi.com',query={Action:'CVProcess',Version:'2022-08-31'};
  const headers=signVolcengineRequest({method:'POST',host,path:'/',query,body,region:'cn-north-1',service:'cv',accessKeyId:env.VOLCENGINE_ACCESS_KEY,secretAccessKey:env.VOLCENGINE_SECRET_KEY});
  const response=await options.fetchImplementation(`https://${host}/?${new URLSearchParams(query)}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(options.timeoutMs??20000)});
  if(!response.ok)throw new Error(`火山抠图返回 HTTP ${response.status}，未自动重试`);
  const result=await response.json();if(result.code!==10000)throw new Error('火山抠图未返回成功结果，未自动重试');
  if(result.request_id)await options.receipt(String(result.request_id));
  const mask=Buffer.from(normalizeMockupBase64Image(result.data?.binary_data_base64?.[0]).base64Data,'base64');
  const rgba=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const maskMeta=await sharp(mask).metadata();
  if(maskMeta.width!==rgba.info.width||maskMeta.height!==rgba.info.height)throw new Error('火山蒙版与原图尺寸不一致，未缩放或替换原图');
  const gray=await sharp(mask).removeAlpha().greyscale().raw().toBuffer();let visible=false,transparent=false;
  for(let i=0;i<gray.length;i++){const a=Math.round(rgba.data[i*4+3]*gray[i]/255);rgba.data[i*4+3]=a;visible ||= a>0;transparent ||= a<255;}
  if(!visible||!transparent)throw new Error('火山抠图没有返回有效透明前景');
  const bytes=await sharp(rgba.data,{raw:{width:rgba.info.width,height:rgba.info.height,channels:4}}).png().toBuffer();
  return {bytes,mask,original:source};
}
