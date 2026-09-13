import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash,jsonFile,saveJSON,readBytes,atomicFile,assetPath,fail } from '../adapters/a-files.mjs';
const stamp=()=>new Date().toISOString();
export const FRAME={width:3252,height:2301,area:{x:144,y:282,width:2964,height:1578},gap:108,version:'ant-shirt-confirmation-frame-v2'};
const statePath=(root,id)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw fail('需求编号无效');return resolve(root,'mockups',id+'.json');};
export const readMockupState=(root,id)=>jsonFile(statePath(root,id),{revision:0,cards:[],history:[]});
export function mockupGroups(c){
 const groups=new Map();
 for(const a of c.draft?.artworks||[])for(const app of a.applications){
  const key=JSON.stringify([app.style,app.color]);if(!groups.has(key))groups.set(key,{style:app.style,color:app.color,slots:{}});
  const slots=groups.get(key).slots;slots[app.position]??=[];if(!slots[app.position].some(x=>x.id===a.id))slots[app.position].push({id:a.id,name:a.name});
 }
 const cards=[];
 for(const [key,g] of groups){const count=Math.max(...Object.values(g.slots).map(x=>x.length)),multi=Object.values(g.slots).filter(x=>x.length>1).length;
  for(let n=0;n<count;n++)cards.push({id:hash(c.caseId+key+':'+n).slice(0,24),style:g.style,color:g.color,version:n+1,slots:g.slots,
   selections:Object.fromEntries(Object.entries(g.slots).map(([p,choices])=>[p,choices.length===1?choices[0].id:multi===1?choices[n]?.id||null:null]))});
 }return cards;
}
export function exactGarment(styles,style,color){const hits=styles.filter(s=>s.styleCode===style).flatMap(s=>s.colors).filter(c=>c.colorName===color);return hits.length===1?hits[0]:null;}
function positionInfo(position){
 if(/后背|背面|后领|背部/.test(position))return {face:'back',key:/后领/.test(position)?'upperBack':'backCenter',anchor:[.5,/后领/.test(position)?.22:.38],width:.45};
 if(/左胸/.test(position))return {face:'front',key:'leftChest',anchor:[.64,.34],width:.2};
 if(/右胸/.test(position))return {face:'front',key:'rightChest',anchor:[.36,.34],width:.2};
 if(/前胸|正面|前面|胸前|前中|大胸|中胸/.test(position))return {face:'front',key:'frontCenter',anchor:[.5,.42],width:.46};
 return null;
}
export async function saveMockupSelection(root,c,body){
 const state=await readMockupState(root,c.caseId);if(body.revision!==state.revision)throw fail('这件衣服的排版已更新，请刷新后再改',409);
 const group=mockupGroups(c).find(g=>g.id===body.cardId);if(!group)throw fail('这份效果图已不在当前要求中',409);
 let card=state.cards.find(x=>x.id===body.cardId);if(!card){card={...group,layers:[],variantId:null};state.cards.push(card);}
 if(body.variantId!==undefined){if(!/^[0-9a-f-]{36}$/.test(body.variantId))throw fail('请选择有效的衣服款色');if(card.variantId!==body.variantId){card.layouts??={};if(card.variantId)card.layouts[card.variantId]={layers:card.layers,assetVersionId:card.assetVersionId};const saved=card.layouts[body.variantId];card.variantId=body.variantId;card.assetVersionId=saved?.assetVersionId||null;card.layers=saved?.layers||[];}}
 if(body.selections){for(const [position,id] of Object.entries(body.selections))if(!group.slots[position]?.some(a=>a.id===id))throw fail('图稿不属于当前衣服位置');card.selections={...card.selections,...body.selections};}
 if(body.layers){if(!Array.isArray(body.layers)||body.layers.length!==card.layers.length)throw fail('图层数量不一致');
  card.layers=body.layers.map(l=>{const prior=card.layers.find(p=>p.id===l.id);if(!prior||!['x','y','width'].every(k=>typeof l[k]==='number'&&Number.isFinite(l[k]))||l.width<.005||l.width>1||l.x<0||l.x>1||l.y<0||l.y>1)throw fail('位置或缩放无效');return {...prior,x:l.x,y:l.y,width:l.width,manual:true};});}
 card.status='pending';state.revision++;state.updatedAt=stamp();await saveJSON(statePath(root,c.caseId),state);return state;
}
async function rgbaTrim(bytes){
 const {data,info}=await sharp(bytes,{limitInputPixels:80000000,failOn:'error'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let left=info.width,top=info.height,right=-1,bottom=-1;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>7){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
 if(right<left)throw fail('图片没有可见内容');
 const box={left,top,width:right-left+1,height:bottom-top+1};return {bytes:await sharp(bytes).extract(box).png().toBuffer(),box};
}
export async function garmentCanvas(garment,bytes,frame){
 if(!garment.views.some(v=>v.face==='front'))throw fail('服装目录缺少正面视图');
 const views=garment.views.filter(v=>['front','back'].includes(v.face)).sort((a,b)=>a.face==='front'?-1:b.face==='front'?1:0);
 const images=[];
 for(const view of views){const crop={left:Math.round(view.crop.x*garment.width),top:Math.round(view.crop.y*garment.height),width:Math.round(view.crop.width*garment.width),height:Math.round(view.crop.height*garment.height)};
  crop.width=Math.min(crop.width,garment.width-crop.left);crop.height=Math.min(crop.height,garment.height-crop.top);
  const trimmed=await rgbaTrim(await sharp(bytes).extract(crop).png().toBuffer());images.push({view,crop,...trimmed});}
 const slotWidth=(FRAME.area.width-FRAME.gap*(views.length-1))/views.length;
 const scale=Math.min(...images.flatMap(i=>[slotWidth/i.box.width,FRAME.area.height/i.box.height]));
 const layers=[],faces=[];
 for(const [n,img] of images.entries()){
  const w=Math.round(img.box.width*scale),h=Math.round(img.box.height*scale),x=Math.round(FRAME.area.x+n*(slotWidth+FRAME.gap)+(slotWidth-w)/2),y=Math.round(FRAME.area.y+(FRAME.area.height-h)/2);
  layers.push({input:await sharp(img.bytes).resize(w,h).png().toBuffer(),left:x,top:y});
  const standard=img.view.history?.find(s=>s.id===img.view.confirmedId&&s.status==='confirmed')?.specification;
  faces.push({face:img.view.face,x,y,width:w,height:h,crop:img.crop,trim:img.box,scale,standard:standard||null});
 }
 const meta=await sharp(frame).metadata();if(meta.width!==FRAME.width||meta.height!==FRAME.height)throw fail('效果图边框尺寸不匹配');
 return {bytes:await sharp(frame).composite(layers).png().toBuffer(),faces};
}
export function initialPlacement(face,info){
 const p=face.standard?.positions?.find(p=>p.key===info.key),f=face.standard?.garmentFrame;
 if(p&&f){const x=(f.x+p.anchor.x*f.width)*face.crop.width,y=(f.y+p.anchor.y*f.height)*face.crop.height;
  return {x:(face.x+(x-face.trim.left)*face.scale)/FRAME.width,y:(face.y+(y-face.trim.top)*face.scale)/FRAME.height,width:Math.min(.8,p.defaultSize.width*f.width*face.crop.width*face.scale/FRAME.width),standard:true};}
 return {x:(face.x+face.width*info.anchor[0])/FRAME.width,y:(face.y+face.height*info.anchor[1])/FRAME.height,width:face.width*info.width/FRAME.width,standard:false};
}
export async function renderMockups(root,c,jobs,catalog){
 const state=await readMockupState(root,c.caseId),groups=mockupGroups(c),styles=await catalog.styles();let changed=false;
 for(const group of groups){
  let card=state.cards.find(x=>x.id===group.id);if(!card){const selected=exactGarment(styles,group.style,group.color);card={...group,variantId:selected?.id||null,assetVersionId:null,layers:[],status:'pending'};state.cards.push(card);changed=true;}
  if(JSON.stringify(card.slots)!==JSON.stringify(group.slots)){card.slots=group.slots;card.selections=Object.fromEntries(Object.entries(group.slots).map(([p,opts])=>[p,opts.some(a=>a.id===card.selections[p])?card.selections[p]:group.selections[p]]));card.status='pending';changed=true;}
  try{
   if(!card.variantId){card.status='needs_garment';card.note='请选择款式和颜色';continue;}
   const garment=await catalog.detail(card.variantId,card.assetVersionId||undefined);card.assetVersionId=garment.assetVersionId;
   const selected=[];const warnings=[];if(c.sourceChanged||c.sourceReadError)warnings.push('WPS 原稿有变化或读取失败，当前仅为之前图稿的预览');
   for(const [position,options] of Object.entries(group.slots)){
    const artId=card.selections[position],info=positionInfo(position);
    if(!artId||!options.some(a=>a.id===artId)){warnings.push(position+'有多个候选，请选择本版图稿');continue;}
    if(!info){warnings.push(position+'没有对应的正背面位置标准，暂未放置');continue;}
    const job=jobs.filter(j=>j.artworkId===artId).at(-1),file=job?.repair?.file||job?.final;
    if(!file){warnings.push(position+'图稿尚未完成');continue;}
    if(job.revision!==c.revision)warnings.push(position+'使用之前要求制作的图稿，请核对');
    if(file.transparentExterior===false)warnings.push(position+'图稿外围仍有背景，请先检查抠图或修补');selected.push({position,info,artId,job,file});
   }
   const inputHash=hash(JSON.stringify({garment:garment.sha256,views:garment.views,frame:FRAME.version,selections:card.selections,layers:card.layers.map(({id,x,y,width})=>({id,x,y,width})),files:selected.map(s=>s.file.sha256)}));
   if(card.render?.inputHash===inputHash&&['ready','preview'].includes(card.status)){if(JSON.stringify(card.warnings)!==JSON.stringify(warnings)){card.warnings=warnings;card.status=warnings.length?'preview':'ready';changed=true;}continue;}
   const base=await garmentCanvas(garment,await catalog.bytes(garment),await catalog.frame());
   const baseHash=hash(base.bytes),baseAsset=`mockup-assets/base-${baseHash}.png`;await atomicFile(assetPath(root,baseAsset),base.bytes);
   const composited=[],layers=[];
   for(const s of selected){const face=base.faces.find(v=>v.face===s.info.face);if(!face){warnings.push(s.position+'需要背面，但该底图没有背面');continue;}
    const source=await readBytes(assetPath(root,s.file.asset));if(hash(source)!==s.file.sha256)throw fail('图稿内容校验失败');
    const trimmed=await rgbaTrim(source),trimSHA=hash(trimmed.bytes),asset=`mockup-assets/logo-${trimSHA}.png`;await atomicFile(assetPath(root,asset),trimmed.bytes);
    const id=hash(card.id+s.position).slice(0,24),prior=card.layers.find(l=>l.id===id&&l.artworkId===s.artId),initial=initialPlacement(face,s.info);
    const layer={id,artworkId:s.artId,jobId:s.job.id,sourceSHA256:s.file.sha256,position:s.position,face:s.info.face,x:prior?.x??initial.x,y:prior?.y??initial.y,width:prior?.width??initial.width,manual:prior?.manual||false,asset,ratio:trimmed.box.height/trimmed.box.width};
    let w=Math.max(1,Math.round(layer.width*FRAME.width)),h=Math.max(1,Math.round(w*layer.ratio));
    const limit=Math.min(1,FRAME.width/w,FRAME.height/h);w=Math.max(1,Math.round(w*limit));h=Math.max(1,Math.round(h*limit));
    const left=Math.max(0,Math.min(FRAME.width-w,Math.round(layer.x*FRAME.width-w/2))),top=Math.max(0,Math.min(FRAME.height-h,Math.round(layer.y*FRAME.height-h/2)));
    layer.x=(left+w/2)/FRAME.width;layer.y=(top+h/2)/FRAME.height;layer.width=w/FRAME.width;
    layers.push(layer);composited.push({input:await sharp(trimmed.bytes).resize(w,h).png().toBuffer(),left,top});
   }
   const bytes=await sharp(base.bytes).composite(composited).png().toBuffer(),sha256=hash(bytes),asset=`mockup-results/${card.id}/${sha256}.png`;await atomicFile(assetPath(root,asset),bytes);
   if(card.render&&card.render.sha256!==sha256)state.history.push({cardId:card.id,...card.render});
   card.layers=layers;card.base={asset:baseAsset,sha256:baseHash};card.garment={id:garment.id,style:garment.styleCode,color:garment.colorName,assetVersionId:garment.assetVersionId,sha256:garment.sha256};
   card.render={asset,sha256,bytes:bytes.length,width:FRAME.width,height:FRAME.height,inputHash:hash(JSON.stringify({garment:garment.sha256,views:garment.views,frame:FRAME.version,selections:card.selections,layers:layers.map(({id,x,y,width})=>({id,x,y,width})),files:selected.map(s=>s.file.sha256)})),renderedAt:stamp()};card.warnings=warnings;card.status=warnings.length?'preview':'ready';card.note='位置按底图标准或预览比例放置；可直接拖动调整。';changed=true;
  }catch(e){card.status='failed';card.error=e.message;changed=true;}
 }
 const retained=state.cards.filter(card=>groups.some(g=>g.id===card.id));if(retained.length!==state.cards.length)changed=true;state.cards=retained;
 if(changed){state.revision++;state.updatedAt=stamp();await saveJSON(statePath(root,c.caseId),state);}return state;
}
