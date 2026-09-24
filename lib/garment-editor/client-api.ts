'use client';
import type { CustomizationState } from './mockup-types';
import { assetId } from './project-state';

export async function api<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
  const r=await fetch('/api/garment-mockup/'+path,{method,cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw new Error(data.error||`请求失败 ${r.status}`);return data;
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
async function asDataUrl(url:string){
  const r=await fetch(url);if(!r.ok)throw new Error('任务图片读取失败');
  const blob=await r.blob();return new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片解码失败'));reader.readAsDataURL(blob);});
}
export async function garmentAiFetch(url:string,options:RequestInit):Promise<Response>{
  const action=url.endsWith('/understand')?'understand':url.endsWith('/generate-back')?'back':url.endsWith('/remove-bg')?'cutout':'generate';
  const input=JSON.parse(String(options.body));
  if(input.base64Image)input.base64Image=await ensureAsset(input.base64Image);
  delete input.imageRef;
  if(input.images)input.images=await Promise.all(input.images.map(async(i:{fileName:string;base64Image:string})=>({fileName:i.fileName,base64Image:await ensureAsset(i.base64Image,i.fileName)})));
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
      if(action==='generate'){
        const image=result.image as Record<string,unknown>;result.image={...image,dataUrl:await asDataUrl(String(image.dataUrl))};
      }else if(action==='back')result.image=await asDataUrl(String(result.image));
      else if(action==='cutout'){result.mask=await asDataUrl(String(result.mask));result.original=await asDataUrl(String(result.original));}
      return Response.json(result);
    }
    await new Promise(resolve=>setTimeout(resolve,2000));
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
