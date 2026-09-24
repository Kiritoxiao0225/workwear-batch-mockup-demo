'use client';
/* eslint-disable @next/next/no-img-element -- Editable canvas and authenticated file previews. */
import { useCallback,useEffect,useRef,useState, type ReactNode, type RefObject } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown,ChevronLeft,Copy,Download,HelpCircle,History,ImageIcon,Layers,MoreHorizontal,PanelLeftClose,PanelLeftOpen,Redo2,Search,Shirt,Trash2,Type,Undo2 } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { useProjectSession } from '@/components/project-session';
import { ToastProvider, useToast } from './ui/toast';
import Sidebar, { type SidebarTab } from './Sidebar';
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
type Conflict={serverRevision:number;serverUpdatedAt:string;open:boolean};
type ApiError=Error&{status?:number;data?:{code?:string;serverRevision?:number;serverUpdatedAt?:string}};
type Menu='history'|'more'|'export'|'help';
const empty=()=>({elements:[]} as CustomizationState);
const clock=(date:Date)=>date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
function download(url:string,name:string){const a=document.createElement('a');a.href=url;a.download=name;a.click();}
const TABS:{id:SidebarTab;label:string;icon:ReactNode}[]=[
  {id:'garment',label:'衣服',icon:<Shirt size={19} aria-hidden="true"/>},
  {id:'logo',label:'Logo',icon:<ImageIcon size={19} aria-hidden="true"/>},
  {id:'text',label:'文字',icon:<Type size={19} aria-hidden="true"/>},
  {id:'layers',label:'图层',icon:<Layers size={19} aria-hidden="true"/>},
];
export default function GarmentWorkspace(){
  const {user,error}=useProjectSession();
  const beforeLogoutRef=useRef<null|(()=>Promise<boolean>)>(null);
  return <main className="gme-page"><AppHeader compact beforeLogout={()=>beforeLogoutRef.current?.()??Promise.resolve(true)} />{user?<div className="gme-scope" key={user.id}><ToastProvider><Workspace userId={user.id} canEdit={user.role!=='viewer'} beforeLogoutRef={beforeLogoutRef} /></ToastProvider><div id="garment-editor-portals" /></div>:<p role="status">{error||'正在连接工作台…'}</p>}</main>;
}
function Workspace({userId,canEdit,beforeLogoutRef}:{userId:string;canEdit:boolean;beforeLogoutRef:RefObject<null|(()=>Promise<boolean>)>}){
  const toast=useToast();
  const [manualSaving,setManualSaving]=useState(false);
  const history=useUndoHistory(empty()),{state,updateState,replaceState,getState,undo,redo,canUndo,canRedo}=history;
  const [project,setProject]=useState({id:'',revision:0,name:'未命名成衣效果图'}),projectRef=useRef(project);
  const [selected,setSelected]=useState<{id:string|null;type:ElementType|null}>({id:null,type:null});
  const [status,setStatus]=useState('正在恢复草稿…'),[savedAt,setSavedAt]=useState<Date|null>(null),[notice,setNotice]=useState(''),[ready,setReady]=useState(false);
  const [conflict,setConflict]=useState<Conflict|null>(null);
  const [panel,setPanel]=useState<'projects'|'jobs'|'versions'|null>(null),[query,setQuery]=useState(''),[page,setPage]=useState(1),[total,setTotal]=useState(0),[pageSize,setPageSize]=useState(30);
  const [garments,setGarments]=useState<Garment[]>([]),[projects,setProjects]=useState<Project[]>([]),[jobs,setJobs]=useState<Job[]>([]),[versions,setVersions]=useState<{revision:number;created_at:string}[]>([]);
  const [busy,setBusy]=useState(false),[removeId,setRemoveId]=useState<string|null>(null);
  const [tab,setTab]=useState<SidebarTab>('garment'),[panelOpen,setPanelOpen]=useState(true),[menu,setMenu]=useState<Menu|null>(null);
  const [panelHost,setPanelHost]=useState<HTMLDivElement|null>(null),[inspectorHost,setInspectorHost]=useState<HTMLElement|null>(null);
  const generation=useRef(0),[stateGeneration,setStateGeneration]=useState(0),canvasArea=useRef<HTMLDivElement>(null),topbar=useRef<HTMLDivElement>(null);
  const exportRef=useRef<(()=>void)|null>(null),captureRef=useRef<((ids:string[])=>Promise<CapturedMockupProduct[]>)|null>(null);
  const lastSaved=useRef(''),saving=useRef<Promise<boolean>|null>(null),pending=useRef<{body:unknown;snapshot:string}|null>(null),blocked=useRef(false),alive=useRef(true);
  const updateProject=useCallback((p:typeof project)=>{projectRef.current=p;setProject(p);setAiProject(p.revision?p.id:null);},[]);
  const replace=useCallback((p:typeof project,s:CustomizationState)=>{generation.current++;setStateGeneration(generation.current);updateProject(p);replaceState(s);setSelected({id:null,type:null});lastSaved.current=JSON.stringify({name:p.name,state:s});pending.current=null;blocked.current=false;setConflict(null);setSavedAt(null);setStatus(p.revision?'已保存':'新工程');},[replaceState,updateProject]);
  useEffect(()=>{alive.current=true;clearAssetCache();let active=true;
    void draftStore(userId).then(async value=>{
      if(!active)return;
      const v=value as {project:typeof project;state:CustomizationState;dirty?:boolean}|undefined;
      if(v?.project?.id&&v.state?.elements){
        replace(v.project,v.state);if(v.dirty){lastSaved.current='';setStatus('已恢复未保存草稿');}
        // The draft may lag behind a save made just before the page closed, or in another window.
        if(v.project.revision>0){
          const head=await api<{revision:number;updatedAt:string}>('projects/'+v.project.id+'/head').catch((e:ApiError)=>e.status===404?null:undefined);
          if(!active)return;
          if(head===null){replace({id:crypto.randomUUID(),revision:0,name:v.project.name},v.state);lastSaved.current='';}
          else if(head&&head.revision>v.project.revision){
            if(v.dirty){blocked.current=true;setConflict({serverRevision:head.revision,serverUpdatedAt:head.updatedAt,open:true});setStatus('版本冲突');}
            else{const p=await api<Project>('projects/'+v.project.id);if(active)replace({id:p.id,name:p.name,revision:p.revision},p.state);}
          }
        }
      }
      else replace({id:crypto.randomUUID(),revision:0,name:'未命名成衣效果图'},empty());
      const input=new URL(location.href).searchParams.get('artwork');
      if(input&&/^\/api\/batch\//.test(input)){
        const url=await ensureAsset(input,'图稿生成结果.png');
        if(active){updateState(s=>({elements:[...s.elements,{id:crypto.randomUUID(),type:'logo',image:url,placedOnProductId:null}]}));setTab('logo');}
        window.history.replaceState(null,'','/garment-mockup');
      }
    }).catch(e=>{if(active){replace({id:crypto.randomUUID(),revision:0,name:'未命名成衣效果图'},empty());setNotice(e.message);}}).finally(()=>{if(active)setReady(true);});
    return()=>{active=false;alive.current=false;clearAssetCache();const p=projectRef.current,s=getState();if(p.id)void draftStore(userId,{project:p,state:s,dirty:JSON.stringify({name:p.name,state:s})!==lastSaved.current}).catch(()=>{});};
  },[userId,replace,updateState,getState]);
  const save=useCallback(async(force=false,allowBlank=false):Promise<boolean>=>{
    if(!canEdit)return true;
    if(!ready)return false;
    if(saving.current)return saving.current;
    if(blocked.current&&!force)return false;
    const p=projectRef.current,s=getState(),snapshot=JSON.stringify({name:p.name,state:s});
    // Autosave never turns a blank canvas into a work; only an explicit save does.
    if(p.revision===0&&s.elements.length===0&&!allowBlank){setStatus('新工程');return true;}
    if(p.revision>0&&snapshot===lastSaved.current&&!pending.current)return true;
    setStatus('保存中…');
    saving.current=(async()=>{
      try{
        if(!pending.current){const fixed=await persistentState(s);pending.current={body:{...p,name:p.name.trim()||'未命名成衣效果图',expectedRevision:p.revision,requestId:crypto.randomUUID(),state:fixed},snapshot};}
        const active=pending.current,result=await api<{id:string;revision:number}>('projects',active.body);
        const next={...projectRef.current,id:result.id,revision:result.revision};updateProject(next);lastSaved.current=active.snapshot;pending.current=null;blocked.current=false;
        // Record the new revision at once, so a quick close cannot leave a stale draft behind.
        const current=getState();void draftStore(userId,{project:next,state:current,dirty:JSON.stringify({name:next.name,state:current})!==lastSaved.current}).catch(()=>{});
        if(alive.current){setStatus('已保存');setSavedAt(new Date());}return true;
      }catch(e){
        blocked.current=true;const err=e as ApiError;
        if(err.status===409&&err.data?.code==='revision_conflict'){
          pending.current=null;
          if(alive.current){setConflict({serverRevision:err.data.serverRevision??0,serverUpdatedAt:err.data.serverUpdatedAt??'',open:true});setStatus('版本冲突');}
          return false;
        }
        if(alive.current){setStatus('保存失败');setNotice(err.message||'保存失败');}return false;
      }
      finally{saving.current=null;}
    })();return saving.current;
  },[ready,canEdit,getState,updateProject,userId]);
  useEffect(()=>{
    if(!ready)return;
    const snapshot=JSON.stringify({name:project.name,state}),dirty=snapshot!==lastSaved.current;
    const timer=setTimeout(()=>{void draftStore(userId,{project,state,dirty}).catch(()=>{setNotice('本地草稿存储失败，请手动保存工程');});if(dirty)void save();},1200);
    return()=>clearTimeout(timer);
  },[state,project,ready,userId,save]);
  useEffect(()=>{
    const handler=(e:BeforeUnloadEvent)=>{if(JSON.stringify({name:projectRef.current.name,state:getState()})!==lastSaved.current&&getState().elements.length){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);
  },[getState]);
  useEffect(()=>{
    if(tab!=='garment'||!panelOpen)return;let active=true;
    const timer=setTimeout(()=>{void fetch('/api/catalog/products?'+new URLSearchParams({q:query,page:String(page)})).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);if(active){setGarments(b.items);setTotal(b.total);setPageSize(b.pageSize||30);}}).catch(e=>{if(active)setNotice(e.message);});},250);
    return()=>{active=false;clearTimeout(timer);};
  },[tab,panelOpen,query,page]);
  useEffect(()=>{
    if(!menu)return;
    const close=(e:MouseEvent)=>{if(!topbar.current?.contains(e.target as Node))setMenu(null);};
    document.addEventListener('mousedown',close);return()=>document.removeEventListener('mousedown',close);
  },[menu]);
  const flushSave=useCallback(async()=>{for(let i=0;i<5;i++){if(!(await save(true)))return false;if(!canEdit||JSON.stringify({name:projectRef.current.name,state:getState()})===lastSaved.current||(!projectRef.current.revision&&!getState().elements.length))return true;}setNotice('内容仍在变化，请稍后重试');return false;},[save,canEdit,getState]);
  useEffect(()=>{beforeLogoutRef.current=flushSave;return()=>{beforeLogoutRef.current=null;};},[beforeLogoutRef,flushSave]);
  const saveManually=async()=>{
    setMenu(null);if(manualSaving)return;
    const blankWork=!projectRef.current.revision&&!getState().elements.length;
    setManualSaving(true);
    try{if(blankWork?await save(true,true):await flushSave())toast.success('作品已保存到「我的作品」，下次可继续编辑。下载图片请点右上角「导出」。');else toast.error('保存未完成，请查看页面提示后重试。');}
    finally{setManualSaving(false);}
  };
  const select=useCallback((id:string|null,type:ElementType|null)=>setSelected({id,type}),[]);
  const open=async(type:typeof panel)=>{
    setMenu(null);
    try{setBusy(true);
      if(type==='projects')setProjects(await api<Project[]>('projects'));
      if(type==='jobs')setJobs(await api<Job[]>('jobs'));
      if(type==='versions'){if(!projectRef.current.revision){toast.info('作品还没有保存过，暂无旧版本');return;}setVersions(await api('projects/'+projectRef.current.id+'/revisions'));}
      setPanel(type);
    }catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  };
  const addProduct=async(g:Garment,face:'front'|'back')=>{
    try{setBusy(true);const file=await api<{url:string}>('import',{variantId:g.id,assetVersionId:g.assetVersionId,face});
      const id=crypto.randomUUID();updateState(s=>({elements:[...s.elements,{id,type:'product',image:file.url,face}]}));select(id,'product');
    }catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  };
  const newProject=async()=>{setMenu(null);if(await flushSave())replace({id:crypto.randomUUID(),revision:0,name:'未命名成衣效果图'},empty());};
  const saveCopy=async()=>{setMenu(null);await saving.current;const p={id:crypto.randomUUID(),revision:0,name:projectRef.current.name+' 副本'};updateProject(p);pending.current=null;blocked.current=false;setConflict(null);lastSaved.current='';if(await save(true))toast.success('已另存为新作品，原作品保持不变。');};
  const loadProject=async(id:string,revision?:number)=>{
    try{if(!(await flushSave()))return;const p=await api<Project>('projects/'+id+(revision?'?revision='+revision:''));replace({id:p.id,name:p.name,revision:p.revision},p.state);if(revision){lastSaved.current='';setStatus('已恢复历史内容，待保存');}setPanel(null);}catch(e){setNotice((e as Error).message);}
  };
  const resolveConflict=async(choice:'copy'|'load'|'overwrite')=>{
    const c=conflict;if(!c)return;setConflict(null);
    if(choice==='copy'){await saveCopy();return;}
    if(choice==='load'){
      try{const p=await api<Project>('projects/'+projectRef.current.id);replace({id:p.id,name:p.name,revision:p.revision},p.state);toast.success(`已载入版本 ${p.revision}`);}
      catch(e){setNotice((e as Error).message);}
      return;
    }
    pending.current=null;blocked.current=false;lastSaved.current='';updateProject({...projectRef.current,revision:c.serverRevision});
    if(await save(true))toast.success(`已用当前内容保存为新版本，版本 ${c.serverRevision} 可在「历史 → 恢复旧版本」找回。`);
  };
  const selectedElement=state.elements.find(e=>e.id===selected.id);
  const exportProducts=async()=>{
    setMenu(null);
    try{const ids=selected.type==='product'&&selected.id?[selected.id]:state.elements.filter(e=>e.type==='product').map(e=>e.id);
      const captures=await captureRef.current?.(ids);if(!captures?.length)throw new Error('请先添加衣服');
      for(const [i,c] of captures.entries())download(c.dataUrl,`${project.name}-${i+1}.jpg`);
    }catch(e){setNotice((e as Error).message);}
  };
  const blank=!project.revision&&!state.elements.length;
  const chip=conflict?{tone:'bad',text:'版本冲突 · 未保存'}
    :status==='保存中…'?{tone:'idle',text:'保存中…'}
    :status==='保存失败'?{tone:'bad',text:'保存失败 · 点此重试'}
    :blank?{tone:'idle',text:'添加内容后自动保存'}
    :status==='已保存'?{tone:'ok',text:savedAt?`已保存 ${clock(savedAt)}`:'已保存'}
    :{tone:'idle',text:status};
  const layerName=(e:CanvasElement)=>e.type==='product'?`衣服 ${e.face==='back'?'背面':'正面'}`:e.type==='logo'?'Logo':e.text?.slice(0,12)||'文字';
  const hasInspector=!!selectedElement;
  return <div className="gme-workspace">
    <div className="gme-topbar" ref={topbar}>
      <button type="button" className="gme-ghost" disabled={busy} onClick={()=>void open('projects')}><ChevronLeft size={16} aria-hidden="true"/>我的作品</button>
      <input className="gme-name" aria-label="作品名称" value={project.name} disabled={!canEdit} onChange={e=>updateProject({...projectRef.current,name:e.target.value})} maxLength={120}/>
      <button type="button" className={`gme-chip gme-chip-${chip.tone}`} aria-live="polite" disabled={chip.tone!=='bad'}
        aria-expanded={conflict?conflict.open:undefined} onClick={()=>{if(conflict)setConflict({...conflict,open:!conflict.open});else if(status==='保存失败'){setNotice('');void save(true);}}}>{chip.text}</button>
      <div className="gme-top-center">
        <button type="button" className="gme-icon" title="撤销" aria-label="撤销" disabled={!canUndo||!canEdit} onClick={undo}><Undo2 size={17}/></button>
        <button type="button" className="gme-icon" title="重做" aria-label="重做" disabled={!canRedo||!canEdit} onClick={redo}><Redo2 size={17}/></button>
      </div>
      <div className="gme-top-right">
        <div className="gme-menu-wrap">
          <button type="button" className="gme-ghost" aria-expanded={menu==='history'} onClick={()=>setMenu(menu==='history'?null:'history')}><History size={16} aria-hidden="true"/><span className="gme-hide-sm">历史</span><ChevronDown size={14} aria-hidden="true"/></button>
          {menu==='history'&&<div className="gme-menu" role="menu">
            <button type="button" role="menuitem" onClick={()=>void open('jobs')}><b>AI 生成记录</b><small>去背景、重绘、背面图的结果</small></button>
            <button type="button" role="menuitem" onClick={()=>void open('versions')}><b>恢复旧版本</b><small>找回以前保存的内容</small></button>
          </div>}
        </div>
        <div className="gme-menu-wrap">
          <button type="button" className="gme-icon" title="更多" aria-label="更多操作" aria-expanded={menu==='more'} onClick={()=>setMenu(menu==='more'?null:'more')}><MoreHorizontal size={18}/></button>
          {menu==='more'&&<div className="gme-menu" role="menu">
            <button type="button" role="menuitem" disabled={!canEdit||manualSaving} onClick={()=>void saveManually()}><b>{manualSaving?'正在保存…':'立即保存'}</b><small>{blank?'空白画布也会保存到「我的作品」':'修改会自动保存，这里可手动确认'}</small></button>
            <button type="button" role="menuitem" disabled={!ready||!canEdit} onClick={()=>void newProject()}><b>新建作品</b><small>保存当前作品，打开空白画布</small></button>
            <button type="button" role="menuitem" disabled={!canEdit||blank} onClick={()=>void saveCopy()}><b>复制为新作品</b><small>保留原作品，另存一份做其他方案</small></button>
            <button type="button" role="menuitem" className="is-danger" disabled={!canEdit||!state.elements.length} onClick={()=>{setMenu(null);setRemoveId('canvas');}}><b>清空画布</b><small>可用撤销恢复</small></button>
          </div>}
        </div>
        <div className="gme-menu-wrap">
          <button type="button" className="gme-icon" title="这些按钮怎么用" aria-label="使用说明" aria-expanded={menu==='help'} onClick={()=>setMenu(menu==='help'?null:'help')}><HelpCircle size={17}/></button>
          {menu==='help'&&<div className="gme-menu gme-help-pop" role="dialog" aria-label="使用说明"><dl>
            <dt>保存</dt><dd>画布有内容后自动保存到「我的作品」，左上角可回到作品列表。</dd>
            <dt>去背景</dt><dd>上传 Logo 会自动去背景；自带透明和纯色底免费处理，其余调用火山，失败时自动改用美图。</dd>
            <dt>历史</dt><dd>查看 AI 生成记录，或恢复以前保存的版本。</dd>
            <dt>导出</dt><dd>「整张图片」用于发给客户；「单件图片」按衣服分别下载，选中衣服时只下载这一件。</dd>
            <dt>粘贴</dt><dd>在衣服标签粘贴图片会加为衣服，其余标签加为 Logo。</dd>
          </dl></div>}
        </div>
        <div className="gme-menu-wrap">
          <button type="button" className="gme-primary" aria-expanded={menu==='export'} onClick={()=>setMenu(menu==='export'?null:'export')}><Download size={16} aria-hidden="true"/>导出<ChevronDown size={14} aria-hidden="true"/></button>
          {menu==='export'&&<div className="gme-menu gme-menu-right" role="menu">
            <button type="button" role="menuitem" onClick={()=>{setMenu(null);exportRef.current?.();}}><b>下载整张图片</b><small>整个画布一张图，发给客户用</small></button>
            <button type="button" role="menuitem" onClick={()=>void exportProducts()}><b>下载单件图片</b><small>{selected.type==='product'?'只下载选中的这件衣服':'每件衣服各一张'}</small></button>
          </div>}
        </div>
      </div>
      {conflict?.open&&<div className="gme-conflict" role="alertdialog" aria-label="作品版本冲突">
        <b>这个作品在另一个窗口保存过</b>
        <p>服务器上已是版本 {conflict.serverRevision}{conflict.serverUpdatedAt?`（${clock(new Date(conflict.serverUpdatedAt))} 保存）`:''}。你正在编辑的内容基于版本 {project.revision}，还没有保存。</p>
        <div><button type="button" className="gme-primary" onClick={()=>void resolveConflict('copy')}>另存为新作品</button><button type="button" onClick={()=>void resolveConflict('load')}>载入版本 {conflict.serverRevision}</button><button type="button" onClick={()=>void resolveConflict('overwrite')}>用我的内容覆盖</button><button type="button" className="gme-link" onClick={()=>setConflict({...conflict,open:false})}>稍后处理</button></div>
        <small>载入会放弃本窗口未保存的修改。覆盖会生成新版本，版本 {conflict.serverRevision} 仍可在「历史 → 恢复旧版本」找回。</small>
      </div>}
    </div>
    {notice&&<div className="gme-notice" role="alert"><span>{notice}</span><button type="button" onClick={()=>setNotice('')}>关闭</button></div>}
    <div className={`gme-body${panelOpen?'':' is-panel-closed'}${hasInspector?' has-inspector':''}`}>
      <nav className="gme-rail" aria-label="编辑工具">
        {TABS.map(t=><button key={t.id} type="button" aria-pressed={panelOpen&&tab===t.id} onClick={()=>{if(panelOpen&&tab===t.id)setPanelOpen(false);else{setTab(t.id);setPanelOpen(true);}}}>{t.icon}<span>{t.label}</span></button>)}
        <span className="gme-rail-spacer"/>
        <button type="button" title={panelOpen?'收起面板':'展开面板'} onClick={()=>setPanelOpen(!panelOpen)}>{panelOpen?<PanelLeftClose size={18} aria-hidden="true"/>:<PanelLeftOpen size={18} aria-hidden="true"/>}<span>{panelOpen?'收起':'展开'}</span></button>
      </nav>
      {panelOpen&&<aside className="gme-panel" style={!canEdit?{pointerEvents:'none',opacity:.65}:undefined}>
        {tab==='garment'&&<section className="gme-sec">
          <div className="gme-sec-head"><h3>素材库</h3><span>{total} 款色</span></div>
          <label className="gme-search"><Search size={14} aria-hidden="true"/><input aria-label="搜索款号或颜色" value={query} placeholder="搜索款号或颜色" onChange={e=>{setQuery(e.target.value);setPage(1);}}/></label>
          <div className="gme-catalog">{garments.map(g=><article key={g.id}><img src={g.thumbnailUrl} alt={`${g.styleCode} ${g.colorName}`}/><b>{g.styleCode}</b><small>{g.colorName}</small><div><button type="button" disabled={busy} onClick={()=>void addProduct(g,'front')}>正面</button>{g.layout==='front_back'&&<button type="button" disabled={busy} onClick={()=>void addProduct(g,'back')}>背面</button>}</div></article>)}</div>
          {!garments.length&&<p className="gme-muted">没有匹配的素材，请先在商品素材库上传。</p>}
          {total>pageSize&&<div className="gme-pager"><button type="button" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page} / {Math.ceil(total/pageSize)}</span><button type="button" disabled={page*pageSize>=total} onClick={()=>setPage(page+1)}>下一页</button></div>}
        </section>}
        {tab==='layers'&&<section className="gme-sec">
          <div className="gme-sec-head"><h3>图层</h3><span>{state.elements.length} 个</span></div>
          {state.elements.length?<ul className="gme-list">{state.elements.map((e,i)=><li key={e.id}><button type="button" className={`gme-item${selected.id===e.id?' is-active':''}`} onClick={()=>select(e.id,e.type)}><span className={`gme-thumb${e.type==='logo'?' gme-checker':''}`}>{e.image?<img src={e.image} alt=""/>:<Type size={15} aria-hidden="true"/>}</span><span className="gme-item-text"><b>{layerName(e)}</b><small>第 {i+1} 层</small></span></button></li>)}</ul>:<p className="gme-muted">画布上还没有内容。</p>}
          {selectedElement&&canEdit&&<div className="gme-tools"><button type="button" onClick={()=>updateState(s=>({elements:copyMockupElement(s.elements,selectedElement.id,crypto.randomUUID())}))}><Copy size={14} aria-hidden="true"/>复制</button><button type="button" className="is-danger" onClick={()=>{updateState(s=>removeElementFromCustomizationState(s,selectedElement.id));select(null,null);}}><Trash2 size={14} aria-hidden="true"/>删除</button></div>}
          <p className="gme-hint">尺寸以素材校准或人工标尺为依据；AI 背面仅作参考。</p>
        </section>}
        <div ref={setPanelHost}/>
      </aside>}
      <div className="gme-canvas" ref={canvasArea} style={!canEdit?{pointerEvents:'none'}:undefined}><Editor state={state} onUpdateState={updateState} onSelectElement={select} selectedElementId={selected.id} selectedElementType={selected.type} exportRef={exportRef} captureProductsRef={captureRef}/>
        {!state.elements.length&&<div className="gme-guide">
          <strong>把 Logo 穿到衣服上</strong>
          <ol>
            <li className="is-current"><button type="button" onClick={()=>{setTab('garment');setPanelOpen(true);}}><i>1</i><b>选衣服</b><span>左侧素材库点「正面」或「背面」</span></button></li>
            <li><button type="button" onClick={()=>{setTab('logo');setPanelOpen(true);}}><i>2</i><b>上传 Logo</b><span>自动去背景，放到默认位置</span></button></li>
            <li><div><i>3</i><b>调整并导出</b><span>拖动微调，右上角导出</span></div></li>
          </ol>
        </div>}
      </div>
      <aside className="gme-inspector" ref={setInspectorHost} hidden={!hasInspector} style={!canEdit?{pointerEvents:'none',opacity:.65}:undefined}/>
    </div>
    <Sidebar state={state} stateGeneration={stateGeneration} getStateGeneration={()=>generation.current} getCurrentState={getState} getCanvasDimensions={()=>({width:canvasArea.current?.clientWidth||800,height:canvasArea.current?.clientHeight||600})} onUpdateState={updateState} isLoggedIn={canEdit} selectedElementId={selected.id} selectedElementType={selected.type} onSelectElement={select} onResetCanvas={()=>setRemoveId('canvas')} activeTab={tab} panelHost={panelOpen?panelHost:null} inspectorHost={inspectorHost}/>
    <Modal open={panel==='projects'} onClose={()=>setPanel(null)} title="我的成衣效果图" maxWidth="max-w-3xl"><div className="gme-project-grid">{projects.map(p=><article key={p.id}>{p.thumbnail&&<img src={p.thumbnail} alt="作品预览"/>}<b>{p.name}</b><small>版本 {p.revision}{p.updated_at?` · ${new Date(p.updated_at).toLocaleString('zh-CN')}`:''}</small><button type="button" onClick={()=>void loadProject(p.id)}>继续编辑</button>{canEdit&&<button type="button" onClick={()=>setRemoveId(p.id)}>删除</button>}</article>)}</div>{!projects.length&&<p>还没有保存的成衣效果图。</p>}</Modal>
    <Modal open={panel==='versions'} onClose={()=>setPanel(null)} title="恢复旧版本"><p>恢复后保存为新版本，已有历史仍保留。</p>{versions.map(v=><p key={v.revision}>版本 {v.revision} · {new Date(v.created_at).toLocaleString('zh-CN')} <button type="button" disabled={!canEdit} onClick={()=>void loadProject(project.id,v.revision)}>恢复</button></p>)}</Modal>
    <Modal open={panel==='jobs'} onClose={()=>setPanel(null)} title="AI 生成记录" maxWidth="max-w-3xl"><button type="button" onClick={()=>void open('jobs')}>刷新任务</button><p>停止等待或关闭页面不会重复提交；结果会保留在这里。</p>{jobs.map(j=>{const url=j.result_json?.transparent||(typeof j.result_json?.image==='string'?j.result_json.image:j.result_json?.image?.dataUrl);return <article className="gme-job" key={j.id}><b>{{understand:'理解要求',generate:'Logo 重绘',cutout:'去背景',back:'AI 背面参考'}[j.action]||j.action}</b><span>{{queued:'排队中',running:'处理中',succeeded:'已完成',failed:'未完成',unknown:'结果待核查'}[j.status]||j.status}</span>{j.error&&<p>{j.error}</p>}{j.result_json?.analysis&&<p>{j.result_json.analysis.summary}</p>}{url&&<><img src={url} alt="任务结果"/><button type="button" onClick={()=>download(url,'成衣制作结果.png')}>下载结果</button><button type="button" disabled={!canEdit} onClick={()=>{const id=crypto.randomUUID(),e:CanvasElement={id,type:j.action==='back'?'product':'logo',image:url,...(j.action==='back'?{face:'back' as const}:{placedOnProductId:null})};updateState(s=>({elements:[...s.elements,e]}));select(id,e.type);setPanel(null);}}>添加到画布</button></>}</article>;})}{!jobs.length&&<p>还没有 AI 制作任务。</p>}</Modal>
    <ConfirmDialog open={!!removeId} title={removeId==='canvas'?'清空当前画布？':'删除这个工程？'} description={removeId==='canvas'?'画布上的内容会被移除，可用撤销恢复。':'历史文件保留，已保存的其他工程不受影响。'} danger onCancel={()=>setRemoveId(null)} onConfirm={()=>{const id=removeId;setRemoveId(null);if(id==='canvas'){updateState(empty());select(null,null);return;}if(id)void api('projects/'+id,undefined,'DELETE').then(()=>{setProjects(p=>p.filter(x=>x.id!==id));if(projectRef.current.id===id)replace({id:crypto.randomUUID(),name:'未命名成衣效果图',revision:0},empty());}).catch(e=>setNotice(e.message));}}/>
  </div>;
}
