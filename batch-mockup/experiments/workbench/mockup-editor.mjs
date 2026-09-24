import {createPlacementWriter} from '/mockup-save.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const W=3252,H=2301;
export function createMockupEditor({api,assetURL=x=>'/'+x,onSaved,toast}){
 let styles=null,catalogPending=null,styleError='',active=null,expanded=null,editEpoch=0;const busy=new Set(),prepared=new Set(),undo=new Map();
 const imageCache=new Map();
 const img=src=>{if(!imageCache.has(src))imageCache.set(src,new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>{imageCache.delete(src);no(Error('图片读取失败'));};i.src=assetURL(src);}));return imageCache.get(src);};
 async function catalog(){if(styles)return styles;if(catalogPending)return catalogPending;catalogPending=api('/api/garments').then(x=>{styles=x.styles;styleError='';return styles;}).catch(e=>{styleError=e.message;throw e;}).finally(()=>{catalogPending=null;});return catalogPending;}
 function html(c){const state=c.mockups||{revision:0,cards:[]};
  if(!state.cards.length)return '<div class="mockup-empty">'+(c.draft?'正在准备衣服款色…':'理解需求后选择衣服')+'</div>';
  return `<div class="garment-gallery" style="--items:${Math.min(state.cards.length,3)}">`+state.cards.map(card=>`<article class="garment-card ${expanded===card.id?'garment-expanded':''}" data-mockup="${esc(card.id)}" data-case="${esc(c.caseId)}"><div class="garment-heading"><strong>${esc(card.garment?.style||card.style)} · ${esc(card.garment?.color||card.color)}${card.version>1?' · 方案'+card.version:''}</strong><button class="garment-close" data-mockup-action="close" aria-label="关闭放大调整" ${expanded===card.id?'':'hidden'}>× 关闭</button></div><div class="garment-selects"><label class="garment-picker">款式<input data-garment-style role="combobox" aria-label="衣服款式" aria-autocomplete="list" aria-expanded="false" aria-controls="styles-${esc(card.id)}" autocomplete="off" placeholder="选择或搜索款式"><div class="garment-options" id="styles-${esc(card.id)}" role="listbox" hidden></div></label><label>颜色<select data-garment-color aria-label="衣服颜色"><option value="">请选择颜色</option></select></label></div><div class="garment-status" role="status">${card.status==='pending'?'正在更新整张图片…':card.status==='failed'?esc(card.error):card.status==='needs_garment'?esc(card.note||'请选择款色'):card.status==='ready'?'整张效果图已保存':'预览 · 请查看下方提醒'}</div><div class="garment-preview"><div class="garment-stage" tabindex="0" role="group" aria-label="点击图片放大调整">${card.render?`<img class="garment-final" loading="lazy" decoding="async" style="display:block;width:100%;max-width:100%;height:auto" width="${W}" height="${H}" src="${assetURL(card.render.asset)}" alt="${esc((card.garment?.style||card.style)+' '+(card.garment?.color||card.color)+' 正反面完整效果图')}" draggable="false"><canvas class="garment-canvas" width="${W}" height="${H}" hidden></canvas>`:`<div class="garment-placeholder${['failed','needs_garment'].includes(card.status)?' garment-placeholder-issue':''}">${card.status==='failed'?'未能合成：'+esc(card.error||'请点击更新效果图重试'):card.status==='needs_garment'?esc(card.note||'请选择款式和颜色'):card.status==='pending'?'正在合成效果图…':'选择款色后呈现正反面带框效果图'}</div>`}</div></div><div class="garment-tools"><button data-mockup-action="copy" ${card.render&&['ready','preview'].includes(card.status)?'':'disabled'}>复制整张图片</button><a ${card.render&&['ready','preview'].includes(card.status)?`href="${assetURL(card.render.asset)}" download="${esc((card.garment?.style||card.style)+'-'+(card.garment?.color||card.color))}.png"`:''}>下载 PNG</a><button data-mockup-action="render">更新效果图</button>${(card.layers||[]).some(l=>l.annotation)?`<button data-mockup-action="annotate" aria-pressed="${!!card.annotateSize}">${card.annotateSize?'隐藏尺寸标注':'显示尺寸标注'}</button>`:''}<button class="garment-more" data-mockup-action="options">更多</button><button data-mockup-action="undo" ${undo.has(card.id)?'':'disabled'}>撤销位置</button></div><small>单击图片放大调整 · 右键复制整张图</small>${(card.warnings||[]).map(w=>`<div class="issue">${esc(w)}</div>`).join('')}${(card.hints||[]).map(h=>`<div class="hint">${esc(h)}</div>`).join('')}${styleError?`<div class="issue">${esc(styleError)}</div>`:''}</article>`).join('')+'</div>';
 }
 function hydrate(cases){for(const c of cases){

  if(c.draft&&!c.mockups?.cards.length&&!prepared.has(c.caseId)){prepared.add(c.caseId);void api('/api/mockups/prepare',{caseId:c.caseId}).then(onSaved).catch(e=>{prepared.delete(c.caseId);toast(e.message);});}
  for(const el of document.querySelectorAll(`[data-mockup][data-case="${c.caseId}"]`)){
   const state=c.mockups,card=state.cards.find(x=>x.id===el.dataset.mockup);if(!card)continue;
   const styleSelect=el.querySelector('[data-garment-style]'),colorSelect=el.querySelector('[data-garment-color]'),status=el.querySelector('.garment-status');
   const setStatus=s=>{status.textContent=s;};
   const picker=el.querySelector('.garment-picker'),options=el.querySelector('.garment-options');let styleId=null,optionIndex=0;
   const normalize=v=>v.toLowerCase().replace(/[\s_-]/g,'');
   // Before a color is chosen, preselect the requirement's style when it names exactly one catalog style.
   const currentStyle=()=>{if(card.variantId)return styles?.find(s=>s.colors.some(v=>v.id===card.variantId));const named=styles?.filter(s=>s.styleCode===card.style)||[];return named.length===1?named[0]:null;};
   const colors=()=>{const found=styles?.find(s=>s.id===styleId);colorSelect.innerHTML='<option value="">请选择颜色</option>'+(found?.colors||[]).map(v=>`<option value="${v.id}" ${v.id===card.variantId?'selected':''}>${esc(v.colorName)}</option>`).join('');};
   const closeOptions=()=>{options.hidden=true;styleSelect.setAttribute('aria-expanded','false');styleSelect.removeAttribute('aria-activedescendant');};
   const applyOptions=()=>{const current=currentStyle();styleId=current?.id||null;styleSelect.value=current?.styleCode||'';colors();closeOptions();};
   const showOptions=(query='')=>{const r=styleSelect.getBoundingClientRect();Object.assign(options.style,{position:'fixed',left:r.left+'px',top:Math.max(4,Math.min(r.bottom,innerHeight-244))+'px',width:r.width+'px',right:'auto'});const hits=(styles||[]).filter(s=>!query||normalize(s.styleCode).includes(normalize(query)));optionIndex=0;options.innerHTML=hits.length?hits.map((s,i)=>`<button type="button" role="option" aria-selected="${i===0}" id="style-${card.id}-${i}" data-style-id="${s.id}">${esc(s.styleCode)}${styles.filter(t=>t.styleCode===s.styleCode).length>1?' · '+esc(s.namespace):''}</button>`).join(''):'<span>没有匹配款式</span>';options.hidden=false;styleSelect.setAttribute('aria-expanded','true');if(hits.length)styleSelect.setAttribute('aria-activedescendant',`style-${card.id}-0`);active=card.id;};
   const choose=button=>{const found=styles?.find(s=>s.id===button.dataset.styleId);if(!found)return;styleId=found.id;styleSelect.value=found.styleCode;closeOptions();colors();
    if(!colorSelect.value){active=card.id;setStatus('请选择该款颜色；当前图片仍是原来的款色');el.querySelector('[data-mockup-action=copy]').disabled=true;el.querySelector('a[download]')?.removeAttribute('href');}
    else{active=null;setStatus('整张效果图已保存');if(card.render&&['ready','preview'].includes(card.status)){el.querySelector('[data-mockup-action=copy]').disabled=false;el.querySelector('a[download]').href=assetURL(card.render.asset);}}
    colorSelect.focus();};
   void catalog().then(()=>{if(el.isConnected)applyOptions();}).catch(e=>setStatus(e.message));
   styleSelect.onfocus=()=>{if(busy.has(card.id))return;styleSelect.select();showOptions();};
   styleSelect.oninput=()=>showOptions(styleSelect.value);
   options.onmousedown=e=>{const button=e.target.closest('[data-style-id]');if(button){e.preventDefault();choose(button);}};
   styleSelect.onkeydown=e=>{const choices=[...options.querySelectorAll('[data-style-id]')];if(e.key==='Escape'&&!options.hidden){e.preventDefault();e.stopPropagation();closeOptions();styleSelect.value=styles?.find(s=>s.id===styleId)?.styleCode||'';if(colorSelect.value&&!busy.has(card.id))active=null;return;}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();if(options.hidden){showOptions();return;}optionIndex=Math.max(0,Math.min(choices.length-1,optionIndex+(e.key==='ArrowDown'?1:-1)));choices.forEach((b,i)=>b.setAttribute('aria-selected',String(i===optionIndex)));if(choices[optionIndex]){styleSelect.setAttribute('aria-activedescendant',choices[optionIndex].id);choices[optionIndex].scrollIntoView({block:'nearest'});}}if(e.key==='Enter'&&!options.hidden&&choices[optionIndex]){e.preventDefault();choose(choices[optionIndex]);}};
   picker.onfocusout=e=>{if(!picker.contains(e.relatedTarget)){closeOptions();styleSelect.value=styles?.find(s=>s.id===styleId)?.styleCode||'';if(colorSelect.value&&!busy.has(card.id))active=null;}};
   let failedPatch=null;
   const writer=createPlacementWriter({initial:state,cardId:card.id,
    write:patch=>api('/api/mockups',{caseId:c.caseId,cardId:card.id,...patch}),
    read:()=>api('/api/mockups?caseId='+encodeURIComponent(c.caseId)),
    onChange:s=>{
     state.revision=s.revision;
     if(s.pending){busy.add(card.id);el.dataset.saving='true';setStatus(s.error?'保存失败，调整仍保留：'+s.error:'正在保存位置，可继续拖动…');el.querySelector('[data-mockup-action=copy]').disabled=true;el.querySelector('a[download]')?.removeAttribute('href');}
     else{busy.delete(card.id);delete el.dataset.saving;setStatus('位置已保存，正在更新整张图片…');if(!drag&&active===card.id)active=null;void onSaved();}
     failedPatch=s.error;
     if(s.error&&!el.querySelector('.mockup-retry')){const controls=document.createElement('div');controls.className='mockup-retry';controls.innerHTML='<button type="button">重试保存</button>';controls.firstChild.onclick=()=>{controls.remove();void writer.retry();};status.after(controls);toast(s.error);}
    }});
   function save(patch){editEpoch++;return writer.submit(patch);}
   colorSelect.onchange=()=>{if(colorSelect.value)void save({variantId:colorSelect.value});};
   const canvas=el.querySelector('canvas'),stage=el.querySelector('.garment-stage'),final=el.querySelector('.garment-final');
   let selected=null,drag=null,baseImage=null,logos=null,ready=null,layers=structuredClone(card.layers),dirty=false;
   async function load(){ready??=Promise.all([img(card.base.asset),Promise.all(layers.map(l=>img(l.asset)))]).then(([b,l])=>{baseImage=b;logos=l;});await ready;}
   const box=l=>({x:l.x*W-l.width*W/2,y:l.y*H-l.width*W*l.ratio/2,w:l.width*W,h:l.width*W*l.ratio});
   const point=e=>{const r=stage.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*W,y:(e.clientY-r.top)/r.height*H};};
   function draw(){if(!baseImage||!logos)return;const g=canvas.getContext('2d');g.clearRect(0,0,W,H);g.drawImage(baseImage,0,0,W,H);layers.forEach((l,n)=>{const b=box(l);g.drawImage(logos[n],b.x,b.y,b.w,b.h);if(l.id===selected){g.strokeStyle='#16825b';g.lineWidth=8;g.strokeRect(b.x,b.y,b.w,b.h);g.fillStyle='#16825b';g.fillRect(b.x+b.w-20,b.y+b.h-20,40,40);}});canvas.hidden=false;}
   if(canvas&&card.base){if(card.status==='pending')void load().then(()=>{if(el.isConnected)draw();}).catch(()=>{});
    stage.onpointerdown=async e=>{if(expanded!==card.id)return;if(e.button!==0||!['ready','preview','pending'].includes(card.status))return;const p=point(e),size=45;let hit=null,resize=false;
     for(const l of [...layers].reverse()){const b=box(l);if(l.id===selected&&Math.abs(p.x-b.x-b.w)<size&&Math.abs(p.y-b.y-b.h)<size){hit=l;resize=true;break;}if(p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h){hit=l;break;}}
     if(!hit){selected=null;if(busy.has(card.id)||card.status==='pending')draw();else canvas.hidden=true;return;}e.preventDefault();try{await load();}catch(err){toast(err.message);return;}
     if(!(e.buttons&1))return;editEpoch++;active=card.id;selected=hit.id;drag={id:hit.id,p,screen:{x:e.clientX,y:e.clientY},moved:false,initial:structuredClone(hit),resize,before:structuredClone(layers),pointer:e.pointerId};stage.setPointerCapture(e.pointerId);draw();
    };
    // A click that jitters a pixel is not a move; saving it would lock the layer as manually placed.
    stage.onpointermove=e=>{if(!drag)return;if(!drag.moved){if(Math.hypot(e.clientX-drag.screen.x,e.clientY-drag.screen.y)<4)return;drag.moved=true;}const p=point(e),l=layers.find(l=>l.id===drag.id);if(drag.resize){const b=box(drag.initial),w=Math.max(.005,Math.min(.8,(p.x-b.x)/W));l.width=w;l.x=(b.x+w*W/2)/W;l.y=(b.y+w*W*l.ratio/2)/H;}else{l.x=Math.max(0,Math.min(1,drag.initial.x+(p.x-drag.p.x)/W));l.y=Math.max(0,Math.min(1,drag.initial.y+(p.y-drag.p.y)/H));}dirty=true;draw();};
    const end=()=>{if(!drag)return;const before=drag.before;drag=null;active=null;if(dirty){dirty=false;undo.set(card.id,before);void save({layers:layers.map(({id,x,y,width})=>({id,x,y,width}))});}else{setTimeout(()=>{if(!drag&&!busy.has(card.id))canvas.hidden=true;},2000);}};
    stage.onpointerup=end;stage.onpointercancel=()=>{if(drag){layers=drag.before;drag=null;dirty=false;active=null;canvas.hidden=true;}};
    stage.oncontextmenu=e=>{if(busy.has(card.id)||!['ready','preview'].includes(card.status)||dirty||failedPatch||!colorSelect.value){e.preventDefault();toast('正在更新图片，完成后再复制');}else canvas.hidden=true;};
    canvas.style.pointerEvents='none';if(final)final.oncontextmenu=stage.oncontextmenu;
   }
   function open(){if(canvas&&card.base)void load().catch(e=>toast(e.message));expanded=card.id;el.classList.add('garment-expanded');el.querySelector('.garment-close').hidden=false;el.querySelector('.garment-close').focus();}
   function close(){if(drag){layers=drag.before;drag=null;dirty=false;}expanded=null;el.classList.remove('garment-expanded');el.querySelector('.garment-close').hidden=true;closeOptions();if(!busy.has(card.id)&&!failedPatch){active=null;applyOptions();}if(canvas)canvas.hidden=!(busy.has(card.id)||card.status==='pending');stage.focus();}
   stage.onclick=e=>{if(e.button===0&&expanded!==card.id){e.preventDefault();open();}};
   stage.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&expanded!==card.id){e.preventDefault();open();}};
   el.onclick=async e=>{if(e.target.closest('a[download]')&&(busy.has(card.id)||failedPatch||!['ready','preview'].includes(card.status))){e.preventDefault();return;}const b=e.target.closest('[data-mockup-action]');if(!b)return;
    const action=b.dataset.mockupAction;
    if(action==='options'){open();return;}
    if(action==='close'){close();return;}
    if(action==='undo'&&undo.has(card.id)){const old=undo.get(card.id);undo.delete(card.id);await save({layers:old.map(({id,x,y,width})=>({id,x,y,width}))});return;}
    if(action==='annotate'){await save({annotateSize:!card.annotateSize});return;}
    if(action==='render'){try{await api('/api/mockups/prepare',{caseId:c.caseId});toast('已提交重新合成，不重复调用生图');await onSaved();}catch(err){toast(err.message);}return;}
    if(action==='copy'){try{if(busy.has(card.id)||!['ready','preview'].includes(card.status)||failedPatch||!colorSelect.value)throw Error('请等图片更新完成');if(!navigator.clipboard?.write||typeof ClipboardItem==='undefined')throw Error('请在图片上右键选择“复制图片”，或下载 PNG');const blob=fetch(assetURL(card.render.asset),{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('完整图片读取失败');return new Blob([await r.arrayBuffer()],{type:'image/png'});});await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('已复制完整带框效果图');}catch(err){toast(err.message);} }
   };
  }
 }}
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&expanded&&!document.querySelector('dialog[open]')){e.preventDefault();document.querySelector('.garment-expanded .garment-close')?.click();}});
 return {html,hydrate,epoch:()=>editEpoch,isEditing:()=>!!active||busy.size>0};
}
