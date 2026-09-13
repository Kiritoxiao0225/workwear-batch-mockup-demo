const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const W=3252,H=2301;
export function createMockupEditor({api,assetURL=x=>'/'+x,onSaved,toast}){
 let styles=null,catalogPending=null,styleError='',active=null,expanded=null;const busy=new Set(),prepared=new Set(),undo=new Map();
 const imageCache=new Map();
 const img=src=>{if(!imageCache.has(src))imageCache.set(src,new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>{imageCache.delete(src);no(Error('图片读取失败'));};i.src=assetURL(src);}));return imageCache.get(src);};
 async function catalog(){if(styles)return styles;if(catalogPending)return catalogPending;catalogPending=api('/api/garments').then(x=>{styles=x.styles;styleError='';return styles;}).catch(e=>{styleError=e.message;throw e;}).finally(()=>{catalogPending=null;});return catalogPending;}
 function html(c){const state=c.mockups||{revision:0,cards:[]};
  if(!state.cards.length)return '<div class="mockup-empty">'+(c.draft?'正在准备衣服款色…':'理解需求后选择衣服')+'</div>';
  return state.cards.map(card=>`<article class="garment-card ${expanded===card.id?'garment-expanded':''}" data-mockup="${esc(card.id)}" data-case="${esc(c.caseId)}"><div class="garment-heading"><strong>${esc(card.garment?.style||card.style)} · ${esc(card.garment?.color||card.color)}${card.version>1?' · 方案'+card.version:''}</strong><button data-mockup-action="expand">放大调整</button></div><div class="garment-selects"><label>款式<input type="search" data-style-search placeholder="搜索货号" aria-label="搜索衣服款式"><select data-garment-style aria-label="衣服款式"><option value="">请选择款式</option></select></label><label>颜色<select data-garment-color aria-label="衣服颜色"><option value="">请选择颜色</option></select></label></div>${Object.entries(card.slots).filter(([,opts])=>opts.length>1).map(([p,opts])=>`<label class="garment-candidate">${esc(p)}使用图稿<select data-garment-candidate="${esc(p)}"><option value="">请选择本版图稿</option>${opts.map(a=>`<option value="${esc(a.id)}" ${card.selections[p]===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></label>`).join('')}<div class="garment-status" role="status">${card.status==='pending'?'正在更新整张图片…':card.status==='failed'?esc(card.error):card.status==='needs_garment'?'请选择款色':card.status==='ready'?'整张效果图已保存':'预览 · 请查看下方提醒'}</div><div class="garment-stage">${card.render?`<img class="garment-final" src="${assetURL(card.render.asset)}" alt="${esc((card.garment?.style||card.style)+' '+(card.garment?.color||card.color)+' 正反面完整效果图')}" draggable="false"><canvas class="garment-canvas" width="${W}" height="${H}" hidden></canvas>`:'<div class="garment-placeholder">选择款色后呈现正反面带框效果图</div>'}</div><div class="garment-tools"><button data-mockup-action="copy" ${card.render&&['ready','preview'].includes(card.status)?'':'disabled'}>复制整张图片</button><a ${card.render&&['ready','preview'].includes(card.status)?`href="${assetURL(card.render.asset)}" download="${esc((card.garment?.style||card.style)+'-'+(card.garment?.color||card.color))}.png"`:''}>下载 PNG</a><button data-mockup-action="render">更新效果图</button><button data-mockup-action="undo" ${undo.has(card.id)?'':'disabled'}>撤销位置</button><button data-mockup-action="close" ${expanded===card.id?'':'hidden'}>收起</button></div><small>左键拖动图案 · 选中后拖角点缩放 · 右键复制整张图</small>${(card.warnings||[]).map(w=>`<div class="issue">${esc(w)}</div>`).join('')}${styleError?`<div class="issue">${esc(styleError)}</div>`:''}</article>`).join('');
 }
 function hydrate(cases){for(const c of cases){
  if(c.draft&&!c.mockups?.cards.length&&!prepared.has(c.caseId)){prepared.add(c.caseId);void api('/api/mockups/prepare',{caseId:c.caseId}).then(onSaved).catch(e=>{prepared.delete(c.caseId);toast(e.message);});}
  for(const el of document.querySelectorAll(`[data-mockup][data-case="${c.caseId}"]`)){
   const state=c.mockups,card=state.cards.find(x=>x.id===el.dataset.mockup);if(!card)continue;
   const styleSelect=el.querySelector('[data-garment-style]'),colorSelect=el.querySelector('[data-garment-color]'),status=el.querySelector('.garment-status');
   const setStatus=s=>{status.textContent=s;};
   const applyOptions=(items,query='')=>{const current=items.find(s=>s.colors.some(v=>v.id===card.variantId));styleSelect.innerHTML='<option value="">请选择款式</option>'+items.filter(s=>s.id===current?.id||!query||s.styleCode.toLowerCase().includes(query.toLowerCase())).map(s=>`<option value="${s.id}" ${s.id===current?.id?'selected':''}>${esc(s.styleCode)}${items.filter(t=>t.styleCode===s.styleCode).length>1?' · '+esc(s.namespace):''}</option>`).join('');colors(items);};
   const colors=items=>{const found=items.find(s=>s.id===styleSelect.value);colorSelect.innerHTML='<option value="">请选择颜色</option>'+(found?.colors||[]).map(v=>`<option value="${v.id}" ${v.id===card.variantId?'selected':''}>${esc(v.colorName)}</option>`).join('');};
   void catalog().then(items=>{if(el.isConnected)applyOptions(items);}).catch(e=>setStatus(e.message));
   el.querySelector('[data-style-search]').oninput=e=>{if(styles)applyOptions(styles,e.target.value);};
   styleSelect.onchange=()=>{colors(styles||[]);if(!colorSelect.value){setStatus('请选择该款颜色；当前图片仍是原来的款色');el.querySelector('[data-mockup-action=copy]').disabled=true;el.querySelector('a[download]')?.removeAttribute('href');}if(colorSelect.value&&card.render&&['ready','preview'].includes(card.status)){el.querySelector('[data-mockup-action=copy]').disabled=false;el.querySelector('a[download]').href=assetURL(card.render.asset);}colorSelect.focus();};
   let failedPatch=null;
   async function save(patch){if(busy.has(card.id))return;busy.add(card.id);active=card.id;setStatus('正在保存并更新整张图片…');el.dataset.saving='true';el.querySelector('[data-mockup-action=copy]').disabled=true;el.querySelector('a[download]')?.removeAttribute('href');
    try{failedPatch=null;el.querySelector('.mockup-retry')?.remove();const saved=await api('/api/mockups',{caseId:c.caseId,cardId:card.id,revision:state.revision,...patch});state.revision=saved.revision;await onSaved();}
    catch(e){failedPatch=patch;setStatus('保存失败，当前调整仍保留：'+e.message);toast(e.message);const controls=document.createElement('div');controls.className='mockup-retry';controls.innerHTML='<button type="button">重试保存</button> <button type="button">取消本次调整</button>';controls.children[0].onclick=async()=>{try{const latest=(await api('/api/requirements')).cases.find(x=>x.caseId===c.caseId)?.mockups;if(latest?.revision!==state.revision){setStatus('版本已变化，请取消本次调整并读取最新结果后再调整');return;}void save(patch);}catch(err){setStatus(err.message);}};controls.children[1].onclick=async()=>{failedPatch=null;active=null;await onSaved();};status.after(controls);}
    finally{busy.delete(card.id);if(!failedPatch)active=null;delete el.dataset.saving;if(!failedPatch)await onSaved();}
   }
   colorSelect.onchange=()=>{if(colorSelect.value)void save({variantId:colorSelect.value});};
   for(const select of el.querySelectorAll('[data-garment-candidate]'))select.onchange=()=>{if(select.value)void save({selections:{[select.dataset.garmentCandidate]:select.value}});};
   const canvas=el.querySelector('canvas'),stage=el.querySelector('.garment-stage'),final=el.querySelector('.garment-final');
   let selected=null,drag=null,baseImage=null,logos=null,ready=null,layers=structuredClone(card.layers),dirty=false;
   async function load(){ready??=Promise.all([img(card.base.asset),Promise.all(layers.map(l=>img(l.asset)))]).then(([b,l])=>{baseImage=b;logos=l;});await ready;}
   const box=l=>({x:l.x*W-l.width*W/2,y:l.y*H-l.width*W*l.ratio/2,w:l.width*W,h:l.width*W*l.ratio});
   const point=e=>{const r=stage.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H};};
   function draw(){const g=canvas.getContext('2d');g.clearRect(0,0,W,H);g.drawImage(baseImage,0,0,W,H);layers.forEach((l,n)=>{const b=box(l);g.drawImage(logos[n],b.x,b.y,b.w,b.h);if(l.id===selected){g.strokeStyle='#16825b';g.lineWidth=8;g.strokeRect(b.x,b.y,b.w,b.h);g.fillStyle='#16825b';g.fillRect(b.x+b.w-20,b.y+b.h-20,40,40);}});canvas.hidden=false;}
   if(canvas&&card.base){void load().catch(()=>{});
    stage.onpointerdown=async e=>{if(e.button!==0||busy.has(card.id)||failedPatch||!['ready','preview'].includes(card.status))return;const p=point(e),size=45;let hit=null,resize=false;
     for(const l of [...layers].reverse()){const b=box(l);if(l.id===selected&&Math.abs(p.x-b.x-b.w)<size&&Math.abs(p.y-b.y-b.h)<size){hit=l;resize=true;break;}if(p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h){hit=l;break;}}
     if(!hit){selected=null;canvas.hidden=true;return;}e.preventDefault();try{await load();}catch(err){toast(err.message);return;}
     active=card.id;selected=hit.id;drag={id:hit.id,p,initial:structuredClone(hit),resize,before:structuredClone(layers),pointer:e.pointerId};stage.setPointerCapture(e.pointerId);draw();
    };
    stage.onpointermove=e=>{if(!drag)return;const p=point(e),l=layers.find(l=>l.id===drag.id);if(drag.resize){const b=box(drag.initial),w=Math.max(.005,Math.min(.8,(p.x-b.x)/W));l.width=w;l.x=(b.x+w*W/2)/W;l.y=(b.y+w*W*l.ratio/2)/H;}else{l.x=Math.max(0,Math.min(1,drag.initial.x+(p.x-drag.p.x)/W));l.y=Math.max(0,Math.min(1,drag.initial.y+(p.y-drag.p.y)/H));}dirty=true;draw();};
    const end=()=>{if(!drag)return;const before=drag.before;drag=null;active=null;if(dirty){dirty=false;undo.set(card.id,before);void save({layers:layers.map(({id,x,y,width})=>({id,x,y,width}))});}else{setTimeout(()=>{if(!drag&&!busy.has(card.id))canvas.hidden=true;},2000);}};
    stage.onpointerup=end;stage.onpointercancel=()=>{if(drag){layers=drag.before;drag=null;dirty=false;active=null;canvas.hidden=true;}};
    stage.oncontextmenu=e=>{if(busy.has(card.id)||!['ready','preview'].includes(card.status)||dirty||failedPatch||!colorSelect.value){e.preventDefault();toast('正在更新图片，完成后再复制');}else canvas.hidden=true;};
    canvas.style.pointerEvents='none';if(final)final.oncontextmenu=stage.oncontextmenu;
   }
   el.onclick=async e=>{if(e.target.closest('a[download]')&&(busy.has(card.id)||failedPatch||!['ready','preview'].includes(card.status))){e.preventDefault();return;}const b=e.target.closest('[data-mockup-action]');if(!b)return;
    const action=b.dataset.mockupAction;
    if(action==='expand'){expanded=card.id;el.classList.add('garment-expanded');el.querySelector('[data-mockup-action="close"]').hidden=false;return;}
    if(action==='close'){expanded=null;el.classList.remove('garment-expanded');b.hidden=true;return;}
    if(action==='undo'&&undo.has(card.id)){const old=undo.get(card.id);undo.delete(card.id);await save({layers:old.map(({id,x,y,width})=>({id,x,y,width}))});return;}
    if(action==='render'){try{await api('/api/mockups/prepare',{caseId:c.caseId});toast('已提交重新合成，不重复调用生图');await onSaved();}catch(err){toast(err.message);}return;}
    if(action==='copy'){try{if(busy.has(card.id)||!['ready','preview'].includes(card.status)||failedPatch||!colorSelect.value)throw Error('请等图片更新完成');if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw Error('请在图片上右键选择“复制图片”，或下载 PNG');const blob=fetch(assetURL(card.render.asset),{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('完整图片读取失败');return new Blob([await r.arrayBuffer()],{type:'image/png'});});await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('已复制完整带框效果图');}catch(err){toast(err.message);} }
   };
  }
 }}
 return {html,hydrate,isEditing:()=>!!active};
}
