'use client';
import type { CustomizationState } from './mockup-types';
import { assetId } from './project-state';

export async function api<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
  const r=await fetch('/api/garment-mockup/'+path,{method,cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();
  // Keep the status and body: a save conflict carries the server's revision.
  if(!r.ok)throw Object.assign(new Error(data.error||`请求失败 ${r.status}`),{status:r.status,data});
  return data;
}
const uploads=new Map<string,Promise<string>>();
let currentProject:string|null=null;
export function setAiProject(id:string|null){currentProject=id;}
export function clearAssetCache(){uploads.clear();currentProject=null;}
export async function ensureAsset(value:string,name='图稿.png'):Promise<string>{
  if(assetId(value))return value;
  const existing=uploads.get(value);if(existing)return existing;
  if(!value.startsWith('data:image/')&&!value.startsWith('blob:')&&!/^\/api\/(catalog\/files|production-files|batch\/)/.test(value))throw new Error('不支持此图片来源，请先上传图片');
  const upload=(async()=>{
    const r=await fetch(value);if(!r.ok)throw new Error('原图读取失败');
    const bytes=await r.blob();
    const result=await fetch('/api/garment-mockup/assets',{method:'POST',headers:{'Content-Type':bytes.type,'X-File-Name':encodeURIComponent(name)},body:bytes});
    const body=await result.json();if(!result.ok)throw new Error(body.error||'图片保存失败');return body.url as string;
  })();
  uploads.set(value,upload);try{return await upload;}catch(e){uploads.delete(value);throw e;}
}
export async function persistentState(state:CustomizationState){
  const elements=[];
  for(const item of state.elements){
    const e={...item};
    if(e.image){e.image=await ensureAsset(e.image);e.imageRef=e.image;}
    if(e.originalImage){e.originalImage=await ensureAsset(e.originalImage);e.originalImageRef=e.originalImage;}
    elements.push(e);
  }
  return {...state,elements};
}
async function blobDataUrl(blob:Blob){
  return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片解码失败'));reader.readAsDataURL(blob);});
}
async function asDataUrl(url:string){
  const r=await fetch(url);if(!r.ok)throw new Error('任务图片读取失败');
  return blobDataUrl(await r.blob());
}
/** The cutout's alpha channel as a grey mask, the shape the edge-cleanup code consumes. */
async function alphaMaskDataUrl(blob:Blob){
  const bitmap=await createImageBitmap(blob);
  const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('浏览器无法创建蒙版画布');
  ctx.drawImage(bitmap,0,0);bitmap.close();
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),d=pixels.data;
  for(let i=0;i<d.length;i+=4){const a=d[i+3];d[i]=a;d[i+1]=a;d[i+2]=a;d[i+3]=255;}
  ctx.putImageData(pixels,0,0);return canvas.toDataURL('image/png');
}
export type CutoutMode='auto'|'standard'|'graphic';
export type CutoutMeta={jobId:string;route:'cache'|'passthrough'|'local_flat'|'provider';engine:'volcengine'|'meitu'|'local'|null;model:string|null;
  fallbackFrom:'volcengine'|'meitu'|null;cached:boolean;charged:boolean;width:number;height:number;timingMs:Record<string,number>};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Background removal in one request: the image bytes go up, the transparent PNG comes back. */
export async function cutoutImage(source:string,{mode='auto',elementId,fileName='Logo.png',signal}:{mode?:CutoutMode;elementId?:string;fileName?:string;signal?:AbortSignal}={}):Promise<{blob:Blob;meta:CutoutMeta}>{
  const r=await fetch(source);if(!r.ok)throw new Error('原图读取失败');
  const body=await r.blob(),id=crypto.randomUUID();
  const headers:Record<string,string>={'Content-Type':body.type||'image/png','X-Request-Id':id,'X-Cutout-Mode':mode,'X-File-Name':encodeURIComponent(fileName)};
  if(currentProject)headers['X-Project-Id']=currentProject;
  if(elementId)headers['X-Element-Id']=encodeURIComponent(elementId);
  let response:Response|null=null;
  try{response=await fetch('/api/garment-mockup/cutouts',{method:'POST',headers,body,signal,cache:'no-store'});}
  catch(error){
    if(signal?.aborted)throw error;
    // The request may have arrived. Look it up by its ID instead of paying again.
    try{await api('cutouts/'+id);}catch{throw error;}
  }
  if(response&&response.status===200&&response.headers.get('content-type')?.startsWith('image/'))
    return {blob:await response.blob(),meta:JSON.parse(decodeURIComponent(response.headers.get('x-cutout-meta')||'{}')) as CutoutMeta};
  if(response&&response.status!==202){const data=await response.json().catch(()=>({}));throw new Error(data.error||`去背景失败（HTTP ${response.status}）`);}
  const deadline=Date.now()+60_000;
  while(Date.now()<deadline){
    if(signal?.aborted)throw new DOMException('去背景继续在后台完成，可在 AI 生成记录查看','AbortError');
    await sleep(500);
    const job=await api<{status:string;error?:string;meta?:CutoutMeta;assets?:{state:string;result?:string}}>('cutouts/'+id);
    if(job.status==='failed'||job.status==='unknown')throw new Error(job.error||'去背景未完成');
    if(job.status==='succeeded'&&job.assets?.state==='done'&&job.assets.result){
      const result=await fetch(job.assets.result);if(!result.ok)throw new Error('去背景结果读取失败');
      return {blob:await result.blob(),meta:{...(job.meta as CutoutMeta),jobId:id}};
    }
  }
  throw new Error('去背景结果待核实，不会重复扣费；稍后可在 AI 生成记录查看');
}
export async function garmentAiFetch(url:string,options:RequestInit):Promise<Response>{
  const action=url.endsWith('/generate-back')?'back':url.endsWith('/remove-bg')?'cutout':null;
  if(!action)throw new Error('不支持的成衣 AI 操作');
  const input=JSON.parse(String(options.body));
  if(action==='cutout'){
    try{
      const {blob,meta}=await cutoutImage(input.base64Image,{mode:input.mode,elementId:input.elementId,signal:options.signal??undefined});
      // Same response shape as before: callers composite the mask onto the original.
      return Response.json({original:await blobDataUrl(blob),mask:await alphaMaskDataUrl(blob),meta});
    }catch(error){
      if(error instanceof DOMException&&error.name==='AbortError')throw error;
      return Response.json({error:error instanceof Error?error.message:'去背景失败'},{status:502});
    }
  }
  if(input.base64Image)input.base64Image=await ensureAsset(input.base64Image);
  delete input.imageRef;
  const id=crypto.randomUUID();
  // The ID is fixed before the POST. An uncertain submit is resolved by GET, not a new call.
  try{await api('jobs',{id,action,input,projectId:currentProject});}
  catch(error){try{await api('jobs/'+id);}catch{throw error;}}
  for(;;){
    if(options.signal?.aborted)throw new DOMException('任务继续在后台运行，可在任务记录查看','AbortError');
    const j=await api<{status:string;error?:string;result_json:Record<string,unknown>}>('jobs/'+id);
    if(j.status==='failed'||j.status==='unknown')return Response.json({error:j.error||'结果待核查，请查看任务记录'},{status:502});
    if(j.status==='succeeded'){
      const result={...j.result_json};
      result.image=await asDataUrl(String(result.image));
      return Response.json(result);
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
}
export async function draftStore(key:string,value?:unknown):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('workwear-garment-editor-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('drafts',value===undefined?'readonly':'readwrite'),store=tx.objectStore('drafts');
      const op=value===undefined?store.get(key):store.put(value,key);let result:unknown;
      op.onsuccess=()=>{result=op.result;};tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>{db.close();reject(tx.error);};
    };
  });
}
