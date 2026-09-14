'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { TaskReviewArtworkEditor } from './task-review-artwork-editor';
import { createLegacyArtworkDraft, type ArtworkDraft } from '@/lib/artwork-editor';
import { renderArtworkPng, loadArtworkImage } from '@/lib/client/render-artwork';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

type EditInput={jobId:string;title:string;requirement:string;revision:number;raw:{asset:string};current:{asset:string;sha256:string};draft:ArtworkDraft|null;history:{requestId:string;revision:number}[]};
const api=async(path:string,body?:unknown)=>readApiJson(await fetchApi('/api/batch/api/production/edit'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'}),'图稿编辑失败');
const dataURL=(blob:Blob)=>new Promise<string>((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result));r.onerror=()=>no(Error('图片导出失败'));r.readAsDataURL(blob);});
export function BatchArtworkEditorHost({frame}:{frame:RefObject<HTMLIFrameElement|null>}){
 const [input,setInput]=useState<(EditInput&{draft:ArtworkDraft})|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const opened=useRef(false),attempt=useRef<{snapshot:string;body:string;requestId:string}|null>(null);
 useEffect(()=>{
  let alive=true;
  const open=async(e:MessageEvent)=>{
   if(e.origin!==location.origin||e.source!==frame.current?.contentWindow||e.data?.type!=='batch-open-artwork'||!String(e.data.jobId).match(/^[a-f0-9]{64}$/)||opened.current)return;
   opened.current=true;setLoading(true);setError('');attempt.current=null;
   try{const result:EditInput=await api('?jobId='+e.data.jobId);let draft=result.draft;
    if(!draft){const url='/api/batch/'+result.current.asset,img=await loadArtworkImage(url);draft=createLegacyArtworkDraft(url);const scale=760/Math.max(img.naturalWidth,img.naturalHeight);draft.graphic.width=img.naturalWidth*scale;draft.graphic.height=img.naturalHeight*scale;draft.graphic.label=result.title;}
    if(alive)setInput({...result,draft});
   }catch(e){if(alive)setError(e instanceof Error?e.message:String(e));opened.current=false;}finally{if(alive)setLoading(false);}
  };
  window.addEventListener('message',open);return()=>{alive=false;window.removeEventListener('message',open);};
 },[frame]);
 const close=()=>{setInput(null);opened.current=false;attempt.current=null;frame.current?.contentWindow?.postMessage({type:'batch-editor-closed'},location.origin);};
 const save=async(draft:ArtworkDraft)=>{if(!input)return;setSaving(true);
  try{
   // Keep one id for an uncertain save; a changed draft gets a different id.
   const snapshot=JSON.stringify(draft);
   if(attempt.current){const receipt:EditInput=await api('?jobId='+input.jobId);if(receipt.history.some(x=>x.requestId===attempt.current!.requestId)){if(attempt.current.snapshot!==snapshot)throw Error('上次修改已保存，请重新打开图稿后继续修改');close();frame.current?.contentWindow?.postMessage({type:'batch-artwork-saved'},location.origin);return;}}
   if(attempt.current?.snapshot!==snapshot){const requestId=crypto.randomUUID(),png=await dataURL(await renderArtworkPng(draft));attempt.current={snapshot,requestId,body:JSON.stringify({jobId:input.jobId,requestId,revision:input.revision,currentSHA256:input.current.sha256,draft,png})};}
   const a=attempt.current!;
   if(a.body.length>2_800_000){const size=1_400_000,count=Math.ceil(a.body.length/size);if(count>32)throw Error('图层文件过大，请减少图层后重试');for(let i=0;i<count;i++)await api('/chunk',{jobId:input.jobId,requestId:a.requestId,index:i,chunk:a.body.slice(i*size,(i+1)*size)});await api('',{jobId:input.jobId,requestId:a.requestId,chunkCount:count});}
   else await api('',JSON.parse(a.body));
   close();frame.current?.contentWindow?.postMessage({type:'batch-artwork-saved'},location.origin);
  }finally{setSaving(false);}
 };
 return <>{(loading||error)&&<div role="status" className="batch-editor-message">{loading?'正在打开图稿编辑器…':error}{error&&<button onClick={()=>setError('')}>关闭</button>}</div>}{input&&<TaskReviewArtworkEditor key={input.jobId} repairEnabled title={input.title} originalRequirement={input.requirement} initialDraft={input.draft} repairOriginalURL={'/api/batch/'+input.raw.asset} saving={saving} onCancel={close} onSave={save} saveLabel="保存并返回列表" saveHint="文字、图层和修补结果一起保存，并更新关联的上衣效果图。"/>}</>;
}
