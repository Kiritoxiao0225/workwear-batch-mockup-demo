'use client';
/* eslint-disable @next/next/no-img-element -- Editable canvas and authenticated file previews. */
import { useCallback,useEffect,useRef,useState, type RefObject } from 'react';
import dynamic from 'next/dynamic';
import { AppHeader } from '@/components/app-header';
import { useProjectSession } from '@/components/project-session';
import { ToastProvider, useToast } from './ui/toast';
import Sidebar from './Sidebar';
import Modal from './ui/modal';
import ConfirmDialog from './ui/confirm-dialog';
import { useUndoHistory } from './useMockupUndoHistory';
import type { CanvasElement,CustomizationState,ElementType,CapturedMockupProduct } from '@/lib/garment-editor/mockup-types';
import { api,persistentState,draftStore,setAiProject,clearAssetCache,ensureAsset } from '@/lib/garment-editor/client-api';
import { copyMockupElement } from '@/lib/garment-editor/mockup-element-relations';
import { removeElementFromCustomizationState } from '@/lib/garment-editor/mockup-measurements';
const Editor=dynamic(()=>import('./Editor'),{ssr:false});
type Project={id:string;name:string;revision:number;state:CustomizationState;thumbnail?:string;updated_at?:string};
type Garment={id:string;styleCode:string;colorName:string;thumbnailUrl:string;layout:string;assetVersionId:string};
type Job={id:string;action:string;status:string;error?:string;result_json?:{image?:string|{dataUrl:string};transparent?:string;analysis?:{summary:string}}};
const empty=()=>({elements:[]} as CustomizationState);
function download(url:string,name:string){const a=document.createElement('a');a.href=url;a.download=name;a.click();}
export default function GarmentWorkspace(){
  const {user,error}=useProjectSession();
  const beforeLogoutRef=useRef<null|(()=>Promise<boolean>)>(null);
  return <main className="gme-page"><AppHeader beforeLogout={()=>beforeLogoutRef.current?.()??Promise.resolve(true)} />{user?<div className="gme-scope" key={user.id}><ToastProvider><Workspace userId={user.id} canEdit={user.role!=='viewer'} beforeLogoutRef={beforeLogoutRef} /></ToastProvider><div id="garment-editor-portals" /></div>:<p role="status">{error||'正在连接工作台…'}</p>}</main>;
}
function Workspace({userId,canEdit,beforeLogoutRef}:{userId:string;canEdit:boolean;beforeLogoutRef:RefObject<null|(()=>Promise<boolean>)>}){
  const toast=useToast();
  const [manualSaving,setManualSaving]=useState(false);
  const history=useUndoHistory(empty()),{state,updateState,replaceState,getState,undo,redo,canUndo,canRedo}=history;
  const [project,setProject]=useState({id:'',revision:0,name:'未命名成衣效果图'}),projectRef=useRef(project);
  const [selected,setSelected]=useState<{id:string|null;type:ElementType|null}>({id:null,type:null});
  const [status,setStatus]=useState('正在恢复草稿…'),[notice,setNotice]=useState(''),[ready,setReady]=useState(false);
  const [panel,setPanel]=useState<'garments'|'projects'|'jobs'|'versions'|null>(null),[query,setQuery]=useState(''),[page,setPage]=useState(1),[total,setTotal]=useState(0);
  const [garments,setGarments]=useState<Garment[]>([]),[projects,setProjects]=useState<Project[]>([]),[jobs,setJobs]=useState<Job[]>([]),[versions,setVersions]=useState<{revision:number;created_at:string}[]>([]);
  const [busy,setBusy]=useState(false),[removeId,setRemoveId]=useState<string|null>(null),[collapsed,setCollapsed]=useState(false);
  const generation=useRef(0),[stateGeneration,setStateGeneration]=useState(0),canvasArea=useRef<HTMLDivElement>(null);
  const exportRef=useRef<(()=>void)|null>(null),captureRef=useRef<((ids:string[])=>Promise<CapturedMockupProduct[]>)|null>(null);
  const lastSaved=useRef(''),saving=useRef<Promise<boolean>|null>(null),pending=useRef<{body:unknown;snapshot:string}|null>(null),blocked=useRef(false),alive=useRef(true);
  const updateProject=useCallback((p:typeof project)=>{projectRef.current=p;setProject(p);setAiProject(p.revision?p.id:null);},[]);
  const replace=useCallback((p:typeof project,s:CustomizationState)=>{generation.current++;setStateGeneration(generation.current);updateProject(p);replaceState(s);setSelected({id:null,type:null});lastSaved.current=JSON.stringify({name:p.name,state:s});pending.current=null;blocked.current=false;setStatus(p.revision?'已保存':'新工程');},[replaceState,updateProject]);
  useEffect(()=>{alive.current=true;clearAssetCache();let active=true;
    void draftStore(userId).then(async value=>{
      if(!active)return;
      const v=value as {project:typeof project;state:CustomizationState;dirty?:boolean}|undefined;
      if(v?.project?.id&&v.state?.elements){replace(v.project,v.state);if(v.dirty){lastSaved.current='';setStatus('已恢复未保存草稿');}}
      else replace({id:crypto.randomUUID(),revision:0,name:'未命名成衣效果图'},empty());
      const input=new URL(location.href).searchParams.get('artwork');
      if(input&&/^\/api\/batch\//.test(input)){
        const url=await ensureAsset(input,'图稿生成结果.png');
        if(active)updateState(s=>({elements:[...s.elements,{id:crypto.randomUUID(),type:'logo',image:url,placedOnProductId:null}]}));
        window.history.replaceState(null,'','/garment-mockup');
      }
    }).catch(e=>{if(active){replace({id:crypto.randomUUID(),revision:0,name:'未命名成衣效果图'},empty());setNotice(e.message);}}).finally(()=>{if(active)setReady(true);});
    return()=>{active=false;alive.current=false;clearAssetCache();const p=projectRef.current,s=getState();if(p.id)void draftStore(userId,{project:p,state:s,dirty:JSON.stringify({name:p.name,state:s})!==lastSaved.current}).catch(()=>{});};
  },[userId,replace,updateState,getState]);
  const save=useCallback(async(force=false):Promise<boolean>=>{
    if(!canEdit)return true;
    if(!ready)return false;
    if(saving.current)return saving.current;
    if(blocked.current&&!force)return false;
    const p=projectRef.current,s=getState(),snapshot=JSON.stringify({name:p.name,state:s});
    if(p.revision>0&&snapshot===lastSaved.current&&!pending.current)return true;
    setStatus('保存中…');
    saving.current=(async()=>{
      try{
        if(!pending.current){const fixed=await persistentState(s);pending.current={body:{...p,name:p.name.trim()||'未命名成衣效果图',expectedRevision:p.revision,requestId:crypto.randomUUID(),state:fixed},snapshot};}
        const active=pending.current,result=await api<{id:string;revision:number}>('projects',active.body);
        const next={...projectRef.current,id:result.id,revision:result.revision};updateProject(next);lastSaved.current=active.snapshot;pending.current=null;blocked.current=false;
        if(alive.current)setStatus('已保存');return true;
      }catch(e){blocked.current=true;if(alive.current){setStatus('保存失败');setNotice(e instanceof Error?e.message:'保存失败');}return false;}
      finally{saving.current=null;}
    })();return saving.current;
  },[ready,canEdit,getState,updateProject]);
  useEffect(()=>{
    if(!ready)return;
    const snapshot=JSON.stringify({name:project.name,state}),dirty=snapshot!==lastSaved.current;
    const timer=setTimeout(()=>{void draftStore(userId,{project,state,dirty}).catch(()=>{setNotice('本地草稿存储失败，请手动保存工程');});if(dirty)void save();},1200);
    return()=>clearTimeout(timer);
  },[state,project,ready,userId,save]);
  useEffect(()=>{
    const handler=(e:BeforeUnloadEvent)=>{if(JSON.stringify({name:projectRef.current.name,state:getState()})!==lastSaved.current){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);
  },[getState]);
  useEffect(()=>{
    if(panel!=='garments')return;let active=true;
    const timer=setTimeout(()=>{void fetch('/api/catalog/products?'+new URLSearchParams({q:query,page:String(page)})).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);if(active){setGarments(b.items);setTotal(b.total);}}).catch(e=>{if(active)setNotice(e.message);});},250);
    return()=>{active=false;clearTimeout(timer);};
  },[panel,query,page]);
  const flushSave=useCallback(async()=>{for(let i=0;i<5;i++){if(!(await save(true)))return false;if(!canEdit||JSON.stringify({name:projectRef.current.name,state:getState()})===lastSaved.current)return true;}setNotice('内容仍在变化，请稍后重试');return false;},[save,canEdit,getState]);
  useEffect(()=>{beforeLogoutRef.current=flushSave;return()=>{beforeLogoutRef.current=null;};},[beforeLogoutRef,flushSave]);
  const saveManually=async()=>{
    if(manualSaving)return;setManualSaving(true);
    try{if(await flushSave())toast.success('作品已保存到「我的作品」，下次可继续编辑。下载图片请点右侧下载按钮。');else toast.error('保存未完成，请查看页面提示后重试。');}
    finally{setManualSaving(false);}
  };
  const select=useCallback((id:string|null,type:ElementType|null)=>setSelected({id,type}),[]);
  const open=async(type:typeof panel)=>{
    try{setBusy(true);
      if(type==='projects')setProjects(await api<Project[]>('projects'));
      if(type==='jobs')setJobs(await api<Job[]>('jobs'));
      if(type==='versions'){if(!projectRef.current.revision){setNotice('请先保存工程');return;}setVersions(await api('projects/'+projectRef.current.id+'/revisions'));}
      setPanel(type);
    }catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  };
  const addProduct=async(g:Garment,face:'front'|'back')=>{
    try{setBusy(true);const file=await api<{url:string}>('import',{variantId:g.id,assetVersionId:g.assetVersionId,face});
      const id=crypto.randomUUID();updateState(s=>({elements:[...s.elements,{id,type:'product',image:file.url,face}]}));select(id,'product');setPanel(null);
    }catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  };
  const newProject=async()=>{if(await flushSave())replace({id:crypto.randomUUID(),revision:0,name:'未命名成衣效果图'},empty());};
  const saveCopy=async()=>{await saving.current;const p={id:crypto.randomUUID(),revision:0,name:project.name+' 副本'};updateProject(p);pending.current=null;blocked.current=false;lastSaved.current='';await save(true);};
  const loadProject=async(id:string,revision?:number)=>{
    try{if(!(await flushSave()))return;const p=await api<Project>('projects/'+id+(revision?'?revision='+revision:''));replace({id:p.id,name:p.name,revision:p.revision},p.state);if(revision){lastSaved.current='';setStatus('已恢复历史内容，待保存');}setPanel(null);}catch(e){setNotice((e as Error).message);}
  };
  const selectedElement=state.elements.find(e=>e.id===selected.id);
  const exportProducts=async()=>{
    try{const ids=selected.type==='product'&&selected.id?[selected.id]:state.elements.filter(e=>e.type==='product').map(e=>e.id);
      const captures=await captureRef.current?.(ids);if(!captures?.length)throw new Error('请先添加衣服');
      for(const [i,c] of captures.entries())download(c.dataUrl,`${project.name}-${i+1}.jpg`);
    }catch(e){setNotice((e as Error).message);}
  };
  return <div className="gme-workspace">
    <div className="gme-toolbar"><input aria-label="工程名称" value={project.name} disabled={!canEdit} onChange={e=>updateProject({...projectRef.current,name:e.target.value})} maxLength={120}/><span className="gme-save-state" role="status">{status}</span><span className="gme-spacer"/>
      <button title="保存当前作品后，打开一个空白画布" disabled={!ready||!canEdit} onClick={()=>void newProject()}>新建作品</button><button title="打开以前保存的作品，继续编辑" disabled={busy} onClick={()=>void open('projects')}>我的作品</button><button title="查看 AI 重绘、抠图、背面生成的进度和结果" onClick={()=>void open('jobs')}>AI 生成记录</button><button title="查看以前保存的版本，找回修改前的内容" onClick={()=>void open('versions')}>恢复旧版本</button><button title="保留原作品，再保存一份可单独修改的新作品" disabled={!canEdit} onClick={()=>void saveCopy()}>复制为新作品</button><button title="保存到我的作品，下次继续编辑；不会下载图片" disabled={!canEdit||!ready||manualSaving} onClick={()=>void saveManually()}>{manualSaving?'正在保存…':'保存作品'}</button><button title="下载选中衣服及其 Logo；未选中时下载所有衣服" onClick={()=>void exportProducts()}>下载单件图片</button><button title="把整个画布下载为一张图片，可发给客户" className="gme-primary" onClick={()=>exportRef.current?.()}>下载整张图片</button>
    </div>
    <div className="gme-help"><p>修改会自动保存到「我的作品」。需要把图片发给客户，请点「下载整张图片」。</p><details><summary>这些按钮怎么用？</summary><dl>
      <dt>新建作品</dt><dd>保存当前作品，再打开一个空白画布。</dd><dt>我的作品</dt><dd>找到以前保存的作品，继续修改。</dd><dt>AI 生成记录</dt><dd>查看 AI 处理进度，找回生成的图片。</dd><dt>恢复旧版本</dt><dd>改错了可找回以前保存的内容，恢复后再保存。</dd><dt>复制为新作品</dt><dd>保留原作品，复制一份做其他方案。</dd><dt>保存作品</dt><dd>把可编辑内容保存到账号，不会下载图片。</dd><dt>下载单件图片</dt><dd>下载选中的衣服及其 Logo；未选中时分别下载所有衣服。</dd><dt>下载整张图片</dt><dd>把整个画布下载为一张图片，用于发给客户。</dd>
    </dl></details></div>
    {notice&&<div className="gme-notice" role="alert">{notice}<button onClick={()=>setNotice('')}>关闭</button></div>}
    <div className="gme-body">
      <aside className={collapsed?'gme-sidebar gme-sidebar-collapsed':'gme-sidebar'}>
        <button className="gme-material-button" disabled={!canEdit} onClick={()=>void open('garments')}>＋ 从商品素材库选衣服</button>
        <div className="gme-side-controls"><button onClick={()=>setCollapsed(!collapsed)}>{collapsed?'展开工具':'收起工具'}</button><button disabled={!canUndo||!canEdit} onClick={undo}>撤销</button><button disabled={!canRedo||!canEdit} onClick={redo}>重做</button></div>
        {!collapsed&&<div className="gme-sidebar-inner" style={!canEdit?{pointerEvents:'none',opacity:.65}:undefined}><Sidebar state={state} stateGeneration={stateGeneration} getStateGeneration={()=>generation.current} getCurrentState={getState} getCanvasDimensions={()=>({width:canvasArea.current?.clientWidth||800,height:canvasArea.current?.clientHeight||600})} onUpdateState={updateState} onCollapse={()=>setCollapsed(true)} isLoggedIn={canEdit} selectedElementId={selected.id} selectedElementType={selected.type} onSelectElement={select} onResetCanvas={()=>setRemoveId('canvas')} /></div>}
      </aside>
      <div className="gme-canvas" ref={canvasArea} style={!canEdit?{pointerEvents:'none'}:undefined}><Editor state={state} onUpdateState={updateState} onSelectElement={select} selectedElementId={selected.id} selectedElementType={selected.type} exportRef={exportRef} captureProductsRef={captureRef}/>
        {!state.elements.length&&<div className="gme-empty"><strong>把图稿穿在成衣上</strong><p>先选择衣服，再添加 Logo 或文字。</p><p>拖动调整位置，保存后随时继续编辑。</p></div>}
      </div>
      <aside className="gme-layers"><h3>画布图层</h3><p>先选中对象，再到左侧编辑。</p>{state.elements.map((e,i)=><button key={e.id} className={selected.id===e.id?'gme-layer-active':''} onClick={()=>select(e.id,e.type)}>{e.image?<img src={e.image} alt=""/>:<span>文</span>}<span>{e.type==='product'?`衣服 ${e.face==='back'?'背面':'正面'}`:e.type==='logo'?'Logo':e.text?.slice(0,12)||'文字'} {i+1}</span></button>)}
        {selectedElement&&canEdit&&<div className="gme-layer-actions"><button onClick={()=>updateState(s=>({elements:copyMockupElement(s.elements,selectedElement.id,crypto.randomUUID())}))}>复制</button><button onClick={()=>{updateState(s=>removeElementFromCustomizationState(s,selectedElement.id));select(null,null);}}>删除</button></div>}
        <small>尺寸以素材校准或人工标尺为依据。AI 背面仅作参考。</small>
      </aside>
    </div>
    <Modal open={panel==='garments'} onClose={()=>setPanel(null)} title="选择成衣底图" maxWidth="max-w-4xl"><div className="gme-picker"><input aria-label="搜索款号或颜色" value={query} placeholder="搜索款号或颜色" onChange={e=>{setQuery(e.target.value);setPage(1);}}/><div className="gme-material-grid">{garments.map(g=><article key={g.id}><img src={g.thumbnailUrl} alt={`${g.styleCode} ${g.colorName}`}/><b>{g.styleCode} · {g.colorName}</b><div><button disabled={busy} onClick={()=>void addProduct(g,'front')}>添加正面</button>{g.layout==='front_back'&&<button disabled={busy} onClick={()=>void addProduct(g,'back')}>添加背面</button>}</div></article>)}</div>{!garments.length&&<p>没有匹配的素材，请先在商品素材库上传。</p>}<div><button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button> 第 {page} 页 · {total} 款色 <button disabled={page*30>=total} onClick={()=>setPage(page+1)}>下一页</button></div></div></Modal>
    <Modal open={panel==='projects'} onClose={()=>setPanel(null)} title="我的成衣效果图" maxWidth="max-w-3xl"><div className="gme-project-grid">{projects.map(p=><article key={p.id}>{p.thumbnail&&<img src={p.thumbnail} alt="工程预览"/>}<b>{p.name}</b><small>版本 {p.revision}</small><button onClick={()=>void loadProject(p.id)}>继续编辑</button>{canEdit&&<button onClick={()=>setRemoveId(p.id)}>删除</button>}</article>)}</div>{!projects.length&&<p>还没有保存的成衣效果图。</p>}</Modal>
    <Modal open={panel==='versions'} onClose={()=>setPanel(null)} title="恢复旧版本"><p>恢复后保存为新版本，已有历史仍保留。</p>{versions.map(v=><p key={v.revision}>版本 {v.revision} · {new Date(v.created_at).toLocaleString()} <button disabled={!canEdit} onClick={()=>void loadProject(project.id,v.revision)}>恢复</button></p>)}</Modal>
    <Modal open={panel==='jobs'} onClose={()=>setPanel(null)} title="AI 生成记录" maxWidth="max-w-3xl"><button onClick={()=>void open('jobs')}>刷新任务</button><p>停止等待或关闭页面不会重复提交；结果会保留在这里。</p>{jobs.map(j=>{const url=j.result_json?.transparent||(typeof j.result_json?.image==='string'?j.result_json.image:j.result_json?.image?.dataUrl);return <article className="gme-job" key={j.id}><b>{{understand:'理解要求',generate:'Logo 重绘',cutout:'透明抠图',back:'AI 背面参考'}[j.action]||j.action}</b><span>{{queued:'排队中',running:'处理中',succeeded:'已完成',failed:'未完成',unknown:'结果待核查'}[j.status]||j.status}</span>{j.error&&<p>{j.error}</p>}{j.result_json?.analysis&&<p>{j.result_json.analysis.summary}</p>}{url&&<><img src={url} alt="任务结果"/><button onClick={()=>download(url,'成衣制作结果.png')}>下载结果</button><button disabled={!canEdit} onClick={()=>{const id=crypto.randomUUID(),e:CanvasElement={id,type:j.action==='back'?'product':'logo',image:url,...(j.action==='back'?{face:'back' as const}:{placedOnProductId:null})};updateState(s=>({elements:[...s.elements,e]}));select(id,e.type);setPanel(null);}}>添加到画布</button></>}</article>;})}{!jobs.length&&<p>还没有 AI 制作任务。</p>}</Modal>
    <ConfirmDialog open={!!removeId} title={removeId==='canvas'?'清空当前画布？':'删除这个工程？'} description="历史文件保留，已保存的其他工程不受影响。" danger onCancel={()=>setRemoveId(null)} onConfirm={()=>{const id=removeId;setRemoveId(null);if(id==='canvas'){updateState(empty());return;}if(id)void api('projects/'+id,undefined,'DELETE').then(()=>{setProjects(p=>p.filter(x=>x.id!==id));if(projectRef.current.id===id)replace({id:crypto.randomUUID(),name:'未命名成衣效果图',revision:0},empty());}).catch(e=>setNotice(e.message));}}/>
  </div>;
}
