import { resolve } from 'node:path';
import sharp from 'sharp';
import {torsoWidthRatio} from '../../lib/server/catalog-body-geometry.ts';
import { createHash } from 'node:crypto';
import {measureSilhouette} from '../../lib/server/catalog-structure-estimate.ts';
import {faceStructurePoints} from '../../lib/server/catalog-structure-recognition.ts';
import {sharedStyleStandards,styleConfirmationKey} from '../../lib/server/catalog-shared-standard.ts';
import {catalogReferenceType,estimatedSopStandard,hasTemplateLandmarks} from '../../lib/catalog-placement-suggestions.ts';
import {MANUAL_STRUCTURES,POSITION_LABELS,allowedPositions} from '../../lib/catalog.ts';
import {PROJECTED_BODY_WIDTH_CM,SOP_STRUCTURES,UNMEASURED_TORSO_SHARE,plausibleTorso,sopStructureFromStandard} from '../../lib/sop-placement.ts';
import {placementGeometry,requestedDimensions,PLACEMENT_POLICY} from './mockup-placement.mjs';
import {clearFaintSpecks} from '../adapters/production-images.mjs';
import {alphaSamples,annotationOverlay,annotationText,colorIssue,irregularShape,outsideGarment} from './mockup-checks.mjs';
import {LOGO_COLOR_POLICY,analyzeLogoColors,decideLogoColor,garmentAccents,promptFixesLogoColor,sourceMentionsColor} from '../../lib/logo-color-sop.ts';
import {colorMessages,garmentColorUnder,logoColorAnalysis,recolorLogo} from './mockup-color.mjs';
import {editRecolorsArtwork} from './production-edit.mjs';
import { hash,jsonFile,saveJSON,readBytes,atomicFile,assetPath,fail } from '../adapters/a-files.mjs';
const stamp=()=>new Date().toISOString();
export const FRAME={width:3252,height:2301,area:{x:144,y:282,width:2964,height:1578},gap:108,version:'ant-shirt-confirmation-frame-v2'};
const statePath=(root,id)=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw fail('需求编号无效');return resolve(root,'mockups',id+'.json');};
export const readMockupState=(root,id)=>jsonFile(statePath(root,id),{revision:0,cards:[],history:[]});
// 更新效果图 queues a render; marking the cards pending shows "正在更新整张图片…" at once (a first render
// after a worker restart took four minutes and looked like nothing happened) and makes the render
// recompose instead of reusing the cached picture. Every render outcome replaces the pending status.
export async function markMockupsPending(root,id){
 const state=await readMockupState(root,id),cards=state.cards.filter(card=>['ready','preview','failed'].includes(card.status));
 if(!cards.length)return state;
 for(const card of cards)card.status='pending';state.revision++;state.updatedAt=stamp();await saveJSON(statePath(root,id),state);return state;
}
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
// Requirement text and catalog names often differ only by a 色 suffix or 橙/橘 wording; an exact name wins,
// and anything but one unambiguous hit is left for the designer to choose.
const colorKey=v=>String(v??'').replace(/\s/g,'').replace(/色$/,'').replace(/[橙桔]/g,'橘');
// Style codes are typed by hand: case, full-width characters and separators vary, and the letter and
// number parts get swapped (SF-719 for 719SF). Each looser tier is tried only when the stricter one finds
// nothing, and only a single style code counts; nearby numbers (8800 vs 8099) are never treated as equal.
const styleText=v=>String(v??'').normalize('NFKC').toUpperCase().replace(/[\s\-_/\\.·•]+/g,'');
const styleParts=v=>(styleText(v).match(/[A-Z]+|\d+|[^A-Z\d]+/g)||[]).sort().join('|');
export function findStyles(styles,style){
 for(const [how,key] of [['exact',v=>String(v??'')],['normalized',styleText],['reordered',styleParts]]){
  const target=key(style);if(!target)continue;
  const named=styles.filter(s=>key(s.styleCode)===target);
  if(named.length&&new Set(named.map(s=>s.styleCode)).size===1)return {named,how};
  if(named.length)return {named:[],how,ambiguous:[...new Set(named.map(s=>s.styleCode))]};
 }
 return {named:[],how:null};
}
export function matchGarment(styles,style,color){const colors=findStyles(styles,style).named.flatMap(s=>s.colors),exact=colors.filter(c=>c.colorName===color),hits=exact.length?exact:colors.filter(c=>colorKey(c.colorName)===colorKey(color));return hits.length===1?hits[0]:null;}
function garmentNote(styles,style,color){
 if(!style||!color)return '需求里没有写明款式或颜色，请选择款式和颜色';
 const found=findStyles(styles,style),named=found.named;
 if(found.ambiguous)return `货号 ${style} 可能是 ${found.ambiguous.join('、')}，请选择款式和颜色`;
 if(!named.length)return `素材库没有款式 ${style}，请选择款式和颜色`;
 return named.flatMap(s=>s.colors).some(c=>colorKey(c.colorName)===colorKey(color))?`${style} 有多个颜色对应「${color}」，请选择颜色`:`${style} 没有「${color}」这个颜色，请选择颜色`;
}
const sizeWarnings=layers=>layers.filter(l=>l.sizeConflict&&l.sizeCm).map(l=>`${l.position}：客户写的宽${l.sizeConflict.width}×高${l.sizeConflict.height}厘米与图稿比例不一致，已按宽${l.sizeConflict.width}厘米等比放置（高约${+l.sizeCm.height.toFixed(2)}厘米），请核对尺寸。`);
// Placement, color and outline checks are stored per layer so a cached render reports them again.
const layerWarnings=layers=>[...sizeWarnings(layers),...layers.flatMap(l=>(l.checks||[]).map(x=>`${l.position}：${x}`))];
// Left/right before 居中 so 左前胸 stays a chest logo; a bare 胸前 is the usual chest logo, not a full front print.
// width is the pre-SOP default share of the face, kept only to recognize old untouched layers.
export function positionInfo(position){
 const p=String(position??'');
 // No position in the requirement means the usual chest logo: a left-chest print.
 if(!p.trim()||/^(原需求)?(未指定|未写明|未说明|没有指定)(位置)?$/u.test(p.trim()))return {face:'front',key:'leftChest',width:.2,defaulted:true};
 // Cap and apron words name a drawn catalog area; key stays the clothing equivalent for other garments.
 if(/帽/.test(p)){if(/后|背/.test(p))return {face:'back',key:'backCenter',width:.45,drawn:'capBack'};if(/左/.test(p))return {face:'front',key:'leftSleeve',width:.1,drawn:'capLeftSide'};if(/右/.test(p))return {face:'front',key:'rightSleeve',width:.1,drawn:'capRightSide'};return {face:'front',key:'frontCenter',width:.46,drawn:'capFront'};}
 if(/围裙/.test(p)&&/口袋/.test(p))return {face:'front',key:'frontCenter',width:.46,drawn:'apronPocket'};
 if(/围裙/.test(p)&&/上部|胸/.test(p))return {face:'front',key:'leftChest',width:.2,drawn:'apronUpper'};
 if(/后领|领后|后脖/.test(p))return {face:'back',key:'upperBack',width:.45};
 if(/后背|背面|背部|后面|背后/.test(p))return {face:'back',key:'backCenter',width:.45};
 if(/左袖|左臂/.test(p))return {face:'front',key:'leftSleeve',width:.1};
 if(/右袖|右臂/.test(p))return {face:'front',key:'rightSleeve',width:.1};
 if(/袖/.test(p))return {face:'front',key:'leftSleeve',width:.1,note:'未写明左右袖，按左袖放置，请核对'};
 if(/右胸|右前胸/.test(p))return {face:'front',key:'rightChest',width:.2};
 if(/左胸|左前胸/.test(p))return {face:'front',key:'leftChest',width:.2};
 if(/居中|正胸|正前|前中|大胸|中胸|大图|前幅|正面|前面/.test(p))return {face:'front',key:'frontCenter',width:.46};
 if(/胸/.test(p))return {face:'front',key:'leftChest',width:.2,note:'未写明左右胸，按左胸放置，请核对'};
 return null;
}
export async function saveMockupSelection(root,c,body){
 const state=await readMockupState(root,c.caseId);if(body.revision!==state.revision)throw fail('这件衣服的排版已更新，请刷新后再改',409);
 const group=mockupGroups(c).find(g=>g.id===body.cardId);if(!group)throw fail('这份效果图已不在当前要求中',409);
 let card=state.cards.find(x=>x.id===body.cardId);if(!card){card={...group,layers:[],variantId:null};state.cards.push(card);}
 if(body.variantId!==undefined){if(!/^[0-9a-f-]{36}$/.test(body.variantId))throw fail('请选择有效的衣服款色');if(card.variantId!==body.variantId){card.layouts??={};if(card.variantId)card.layouts[card.variantId]={layers:card.layers,assetVersionId:card.assetVersionId};const saved=card.layouts[body.variantId];card.variantId=body.variantId;card.assetVersionId=saved?.assetVersionId||null;card.layers=saved?.layers||[];}}
 // SOP 2.2 size notes are drawn only when the designer turns them on for this card.
 if(body.annotateSize!==undefined){if(typeof body.annotateSize!=='boolean')throw fail('尺寸标注开关无效');card.annotateSize=body.annotateSize;}
 if(body.selections){for(const [position,id] of Object.entries(body.selections))if(!group.slots[position]?.some(a=>a.id===id))throw fail('图稿不属于当前衣服位置');card.selections={...card.selections,...body.selections};}
 if(body.layers){if(!Array.isArray(body.layers)||body.layers.length!==card.layers.length)throw fail('图层数量不一致');
  card.layers=body.layers.map(l=>{const prior=card.layers.find(p=>p.id===l.id);if(!prior||!['x','y','width'].every(k=>typeof l[k]==='number'&&Number.isFinite(l[k]))||l.width<.005||l.width>1||l.x<0||l.x>1||l.y<0||l.y>1)throw fail('位置或缩放无效');const moved=l.x!==prior.x||l.y!==prior.y,resized=l.width!==prior.width;return {...prior,x:l.x,y:l.y,width:l.width,manual:prior.manual||moved||resized,positionManual:prior.positionManual??prior.manual??moved,sizeManual:prior.sizeManual??(resized?true:undefined),...(moved?{positionManual:true}:{}),...(resized?{sizeManual:true}:{})};});}
 card.status='pending';state.revision++;state.updatedAt=stamp();await saveJSON(statePath(root,c.caseId),state);return state;
}
// Older artworks predate speck cleaning at output, so trimming applies the same rule.
async function rgbaTrim(bytes){
 const {data,info}=await sharp(bytes,{limitInputPixels:80000000,failOn:'error'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const cleaned=clearFaintSpecks(data,info.width,info.height,info.channels);
 let left=info.width,top=info.height,right=-1,bottom=-1;
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>7){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
 if(right<left)throw fail('图片没有可见内容');
 const box={left,top,width:right-left+1,height:bottom-top+1};return {bytes:await (cleaned?sharp(data,{raw:{width:info.width,height:info.height,channels:info.channels}}):sharp(bytes)).extract(box).png().toBuffer(),box};
}
export async function garmentCanvas(garment,bytes,frame,shared={}){
 if(!garment.views.some(v=>v.face==='front'))throw fail('服装目录缺少正面视图');
 const views=garment.views.filter(v=>['front','back'].includes(v.face)).sort((a,b)=>a.face==='front'?-1:b.face==='front'?1:0);
 const images=[];
 for(const view of views){const crop={left:Math.round(view.crop.x*garment.width),top:Math.round(view.crop.y*garment.height),width:Math.round(view.crop.width*garment.width),height:Math.round(view.crop.height*garment.height)};
  crop.width=Math.min(crop.width,garment.width-crop.left);crop.height=Math.min(crop.height,garment.height-crop.top);
  const trimmed=await rgbaTrim(await sharp(bytes).extract(crop).png().toBuffer());images.push({view,crop,...trimmed});}
 const slotWidth=(FRAME.area.width-FRAME.gap*(views.length-1))/views.length;
 const scale=Math.min(...images.flatMap(i=>[slotWidth/i.box.width,FRAME.area.height/i.box.height]));
 const layers=[],faces=[];let imageKey=null;
 for(const [n,img] of images.entries()){
  const w=Math.round(img.box.width*scale),h=Math.round(img.box.height*scale),x=Math.round(FRAME.area.x+n*(slotWidth+FRAME.gap)+(slotWidth-w)/2),y=Math.round(FRAME.area.y+(FRAME.area.height-h)/2);
  const garmentLayer=await sharp(img.bytes).resize(w,h).png().toBuffer();layers.push({input:garmentLayer,left:x,top:y});
  // SOP 5 1.2: the garment's colors by area; the largest is the body, the rest are 撞色 a logo may take.
  const tone=await sharp(garmentLayer).resize(320,320,{fit:'inside'}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const confirmedSpec=img.view.history?.find(s=>s.id===img.view.confirmedId&&s.status==='confirmed')?.specification;
  const templateOnly=!!confirmedSpec&&SOP_STRUCTURES.includes(confirmedSpec.structureType)&&hasTemplateLandmarks(confirmedSpec,img.view.face,catalogReferenceType(garment.namespace??'',garment.styleCode??'').longSleeve);
  const own=templateOnly?null:confirmedSpec,borrowed=!own&&shared[img.view.face];
  const standard=own||borrowed?.specification;
  // Crop-fraction point → frame pixels of this placed face.
  const toFrame=p=>({x:x+(p.x*img.crop.width-img.box.left)*scale,y:y+(p.y*img.crop.height-img.box.top)*scale});
  const bounds={x,y,width:w,height:h};
  // Marked armpits are the body width once confirmed (own or shared), as in the catalog view; otherwise the
  // lower-torso silhouette gives it, unless long sleeves merged with the body there and it spans the whole garment.
  // Long sleeves touching the body defeat the lower-torso width; the torso just under separated sleeves is the next evidence.
  const reference=catalogReferenceType(garment.namespace??'',garment.styleCode??''),type=standard&&standard.structureType!=='unknown'?standard.structureType:reference.structure;
  const frameBox={x:img.box.left/img.crop.width,y:img.box.top/img.crop.height,width:img.box.width/img.crop.width,height:img.box.height/img.crop.height};
  const m=await measureSilhouette(bytes,img.view.crop),alphaRatio=plausibleTorso(type,await torsoWidthRatio(bytes,img.view.crop)??m?.torsoAtArmpit??null,frameBox.width);
  let bodyWidth=alphaRatio?alphaRatio*img.crop.width*scale:null,basis=alphaRatio?'alpha-torso-v1':'unconfirmed-preview',structure=null,source='fallback';
  if(standard&&SOP_STRUCTURES.includes(standard.structureType)){
   const f=standard.garmentFrame,origin=toFrame({x:f.x,y:f.y}),s=sopStructureFromStandard(standard,{width:f.width*img.crop.width*scale,height:f.height*img.crop.height*scale},null);
   if(s){const move=p=>p&&{x:p.x+origin.x,y:p.y+origin.y};structure={...s,neck:move(s.neck),leftShoulder:move(s.leftShoulder),rightShoulder:move(s.rightShoulder),leftArmpit:move(s.leftArmpit),rightArmpit:move(s.rightArmpit),button2:move(s.button2),button3:move(s.button3),center:s.center+origin.x,bounds,exclusions:s.exclusions.map(e=>({...e,x:e.x+origin.x,y:e.y+origin.y}))};source=own?'confirmed':'shared';bodyWidth=s.bodyWidth;basis='confirmed-armpits';}
  }
  if(!structure){
   // Unconfirmed faces use the same estimated standard the catalog shows as its suggestion, with the points recognized on the image.
   const found=m&&await faceStructurePoints({key:imageKey??=createHash('sha256').update(bytes).digest('hex'),load:async()=>bytes},img.view.crop,img.view.face,type,m.points,m.center);
   const spec=m&&estimatedSopStandard(type,img.view.face,frameBox,{...m,points:found.points},{width:w,height:h},bodyWidth,reference.longSleeve),s=spec&&sopStructureFromStandard(spec,{width:w,height:h},bodyWidth);
   if(s){const move=p=>p&&{x:p.x+x,y:p.y+y};structure={...s,neck:move(s.neck),leftShoulder:move(s.leftShoulder),rightShoulder:move(s.rightShoulder),leftArmpit:move(s.leftArmpit),rightArmpit:move(s.rightArmpit),center:s.center+x,bounds,exclusions:s.exclusions.map(e=>({...e,x:e.x+x,y:e.y+y}))};source=m.armpitDetected?'estimated':'estimated-rough';}
  }
  faces.push({face:img.view.face,structureType:type,x,y,width:w,height:h,crop:img.crop,trim:img.box,scale,standard:standard||null,bodyWidth,bodyCenter:structure?.center??x+w/2,bodyBasis:basis,structure,structureSource:source,sharedFrom:source==='shared'?borrowed.colorName:null,templateOnly,garmentAlpha:await alphaSamples(garmentLayer,w,h),accents:garmentAccents(analyzeLogoColors(tone.data,tone.info.width,tone.info.height))});
 }
 const meta=await sharp(frame).metadata();if(meta.width!==FRAME.width||meta.height!==FRAME.height)throw fail('效果图边框尺寸不匹配');
 return {bytes:await sharp(frame).composite(layers).png().toBuffer(),faces};
}
// Caps and aprons have no structure points: the catalog draws each print area with a sample logo, and the
// logo takes that sample's center and fits its size (as in the WPS and simple batch pipelines). Customer
// centimetres and body width do not apply; an area never drawn or confirmed is reported, never guessed.
const DRAWN_KEYS={cap:{leftChest:'capFront',rightChest:'capFront',frontCenter:'capFront',leftSleeve:'capLeftSide',rightSleeve:'capRightSide',backCenter:'capBack',upperBack:'capBack'},apron:{leftChest:'apronUpper',rightChest:'apronUpper',frontCenter:'frontCenter'}};
export const drawnFace=face=>MANUAL_STRUCTURES.includes(face?.standard?.structureType??face?.structureType);
function drawnPlacement(face,info,ratio){
 const spec=face.standard,type=spec?.structureType??face.structureType,keys=allowedPositions(type,face.face);
 const key=info.drawn&&keys.includes(info.drawn)?info.drawn:DRAWN_KEYS[type][info.key],p=key&&spec?.positions.find(x=>x.key===key);
 if(!p)throw fail(`该款没有确认过「${POSITION_LABELS[key]??POSITION_LABELS[info.drawn]??'该位置'}」，请到商品素材库画框并确认`);
 const f=spec.garmentFrame,sx=face.crop.width*face.scale,sy=face.crop.height*face.scale;
 const boxW=p.defaultSize.width*f.width*sx,boxH=p.defaultSize.height*f.height*sy,width=Math.min(boxW,boxH/ratio);
 const x=face.x+((f.x+p.anchor.x*f.width)*face.crop.width-face.trim.left)*face.scale,y=face.y+((f.y+p.anchor.y*f.height)*face.crop.height-face.trim.top)*face.scale;
 return {x,y,width,height:width*ratio,requested:false,sizeConflict:null,policy:PLACEMENT_POLICY,sizeCm:null,basis:'catalog-drawn',standard:true,rule:`按素材库画的「${POSITION_LABELS[key]}」位置和示例 Logo 大小放置`,warnings:[]};
}
export function initialPlacement(face,info,ratio=1,prompt='',options={}){
 if(drawnFace(face)){const p=drawnPlacement(face,info,ratio);return {...p,x:p.x/FRAME.width,y:p.y/FRAME.height,width:p.width/FRAME.width};}
 const provisional=!(face.bodyWidth>0);const p=placementGeometry(provisional?{...face,bodyWidth:face.width*UNMEASURED_TORSO_SHARE}:face,info,ratio,prompt,options);if(provisional){if(p.requested)throw fail('此款尚未标定衣身，无法按客户厘米数精确放置，请在素材库确认左右腋点');p.sizeCm=null;p.basis='unconfirmed-preview';}return {...p,x:p.x/FRAME.width,y:p.y/FRAME.height,width:p.width/FRAME.width};
}
// Older UI marked every submitted layer manual, even when only its position changed.
// A stored width still equal to that version's automatic width is not evidence of resizing.
export function hasManualSize(prior,face,info){
 if(prior?.sizeManual!==undefined)return prior.sizeManual;
 if(!prior?.manual)return false;
 const p=face.standard?.positions?.find(p=>p.key===info.key),f=face.standard?.garmentFrame;
 const automatic=p&&f?Math.min(.8,p.defaultSize.width*f.width*face.crop.width*face.scale/FRAME.width):face.width*info.width/FRAME.width;
 return !Number.isFinite(automatic)||Math.abs(prior.width*FRAME.width-Math.round(automatic*FRAME.width))>.01;
}
export async function renderMockups(root,c,jobs,catalog){
 const state=await readMockupState(root,c.caseId),groups=mockupGroups(c),styles=await catalog.styles();let changed=false;
 for(const group of groups){
  let card=state.cards.find(x=>x.id===group.id);if(!card){card={...group,variantId:null,assetVersionId:null,layers:[],status:'pending'};state.cards.push(card);changed=true;}
  if(JSON.stringify(card.slots)!==JSON.stringify(group.slots)){card.slots=group.slots;card.selections=Object.fromEntries(Object.entries(group.slots).map(([p,opts])=>[p,opts.some(a=>a.id===card.selections[p])?card.selections[p]:group.selections[p]]));card.status='pending';changed=true;}
  try{
   // Retry unmatched cards on every render so catalog or matching fixes reach existing requirements.
   if(!card.variantId){const found=matchGarment(styles,group.style,group.color);if(!found){const note=garmentNote(styles,group.style,group.color);if(card.status!=='needs_garment'||card.note!==note){card.status='needs_garment';card.note=note;changed=true;}continue;}card.variantId=found.id;const style=findStyles(styles,group.style);card.styleMatch=style.how==='exact'?null:`需求写的货号是「${group.style}」，已按素材库款式「${style.named[0].styleCode}」匹配，请核对`;changed=true;}
   const garment=await catalog.detail(card.variantId,card.assetVersionId||undefined);card.assetVersionId=garment.assetVersionId;
   const style=styles.find(s=>s.colors?.some(v=>v.id===garment.id)),sharing=style?styleConfirmationKey(style,garment.id):null;
   const selected=[];const warnings=[];if(c.sourceChanged||c.sourceReadError)warnings.push('WPS 原稿有变化或读取失败，当前仅为之前图稿的预览');
   for(const [slot,options] of Object.entries(group.slots)){
    const info=positionInfo(slot),position=info?.defaulted?'左前胸':slot,artId=card.selections[slot];
    if(!artId||!options.some(a=>a.id===artId)){warnings.push(position+'的多个方案配对尚未明确，请在需求理解中拆分或明确对应关系');continue;}
    if(!info){warnings.push(position+'没有对应的正背面位置标准，暂未放置');continue;}
    const job=jobs.filter(j=>j.artworkId===artId).at(-1),file=job?.repair?.file||job?.final;
    if(!file){warnings.push(position+'图稿尚未完成');continue;}
    if(job.revision!==c.revision)warnings.push(position+'使用之前要求制作的图稿，请核对');
    if(file.transparentExterior===false)warnings.push(position+'图稿外围仍有背景，请先检查抠图或修补');if(info.note)warnings.push(position+'：'+info.note);
    const sizeReference=c.draft.artworks.find(a=>a.id===artId)?.applications.find(x=>x.style===group.style&&x.color===group.color&&x.position===slot)?.sizeReference||null;
    selected.push({position,info,artId,job,file,sizeReference});
   }
   const renderKey=layers=>hash(JSON.stringify({placementPolicy:PLACEMENT_POLICY,colorPolicy:LOGO_COLOR_POLICY,garment:garment.sha256,views:garment.views,sharing,annotateSize:!!card.annotateSize,frame:FRAME.version,selections:card.selections,layers:layers.map(({id,x,y,width})=>({id,x,y,width})),files:selected.map(s=>[s.file.sha256,c.draft.artworks.find(a=>a.id===s.artId)?.prompt,s.sizeReference])}));
   const inputHash=renderKey(card.layers);
   if(card.render?.inputHash===inputHash&&['ready','preview'].includes(card.status)){for(const l of card.layers)if(l.placementBasis==='unconfirmed-preview')warnings.push(l.position+'：此款衣身尚未标定，当前为可调整的比例预览；厘米尺寸需在素材库确认左右腋点。');warnings.push(...layerWarnings(card.layers));if(JSON.stringify(card.warnings)!==JSON.stringify(warnings)){card.warnings=warnings;card.status=warnings.length?'preview':'ready';changed=true;}continue;}
   const garmentBytes=await catalog.bytes(garment);
   const shared=style?await sharedStyleStandards(garment,garmentBytes,style,async id=>{const detail=await catalog.detail(id);return {detail,bytes:await catalog.bytes(detail)};}):{};
   const base=await garmentCanvas(garment,garmentBytes,await catalog.frame(),shared);
   const baseHash=hash(base.bytes),baseAsset=`mockup-assets/base-${baseHash}.png`;await atomicFile(assetPath(root,baseAsset),base.bytes);
   const composited=[],layers=[],notes=[],baseRaw=await sharp(base.bytes).raw().toBuffer({resolveWithObject:true});
   if(card.styleMatch)notes.push(card.styleMatch);
   for(const face of base.faces)if(selected.some(s=>s.info.face===face.face)&&face.structureSource!=='confirmed'){
    const side=face.face==='front'?'正面':'背面';
    if(face.structureSource==='shared'){notes.push(`${side}沿用同款「${face.sharedFrom}」已确认的结构点（轮廓一致）`);continue;}
    if(face.templateOnly)warnings.push(`${side}：素材库确认的结构点仍是系统模板原值，已改按衣服轮廓估算；请在素材库拖到实际位置后重新确认`);
    if(face.structureSource==='estimated-rough')warnings.push(`${side}：未能从衣服轮廓识别腋下线，位置按比例估算、可能偏差较大，请在素材库确认该款结构点`);
    else notes.push(`${side}位置按衣服轮廓估算；在素材库确认该款结构点后更准确`);
   }
   for(const s of selected){const face=base.faces.find(v=>v.face===s.info.face);if(!face){warnings.push(s.position+'需要背面，但该底图没有背面');continue;}
    const source=await readBytes(assetPath(root,s.file.asset));if(hash(source)!==s.file.sha256)throw fail('图稿内容校验失败');
    const trimmed=await rgbaTrim(source),trimSHA=hash(trimmed.bytes),asset=`mockup-assets/logo-${trimSHA}.png`;await atomicFile(assetPath(root,asset),trimmed.bytes);
    const id=hash(card.id+s.position).slice(0,24),prior=card.layers.find(l=>l.id===id&&l.artworkId===s.artId),keepPosition=prior?.positionManual??prior?.manual,keepSize=hasManualSize(prior,face,s.info);
    const initial=keepPosition&&keepSize?prior:initialPlacement(face,s.info,trimmed.box.height/trimmed.box.width,c.draft.artworks.find(a=>a.id===s.artId)?.prompt,{sizeReference:s.sizeReference});
    // A kept manual layout takes the face's current basis: confirming the points later must clear the preview state.
    const basis=keepPosition&&keepSize?(drawnFace(face)?'catalog-drawn':face.bodyWidth>0?face.bodyBasis:'unconfirmed-preview'):initial.basis;
    if(basis==='unconfirmed-preview')warnings.push(s.position+'：此款衣身尚未标定，当前为可调整的比例预览；厘米尺寸需在素材库确认左右腋点。');
    const layer={id,artworkId:s.artId,jobId:s.job.id,sourceSHA256:s.file.sha256,position:s.position,face:s.info.face,x:keepPosition?prior.x:initial.x,y:keepPosition?prior.y:initial.y,width:keepSize?prior.width:initial.width,manual:prior?.manual||false,positionManual:!!keepPosition,sizeManual:!!keepSize,placementPolicy:PLACEMENT_POLICY,placementBasis:basis||prior?.placementBasis,sizeCm:initial.sizeCm||null,sizeConflict:!keepSize&&initial.sizeConflict||null,requested:!!(initial.requested??prior?.requested),rule:initial.rule||prior?.rule||null,asset,sourceAsset:asset,ratio:trimmed.box.height/trimmed.box.width};
    let w=Math.max(1,Math.round(layer.width*FRAME.width)),h=Math.max(1,Math.round(w*layer.ratio));
    const limit=Math.min(1,FRAME.width/w,FRAME.height/h);w=Math.max(1,Math.round(w*limit));h=Math.max(1,Math.round(h*limit));
    const left=Math.max(0,Math.min(FRAME.width-w,Math.round(layer.x*FRAME.width-w/2))),top=Math.max(0,Math.min(FRAME.height-h,Math.round(layer.y*FRAME.height-h/2)));
    const renderedX=(left+w/2)/FRAME.width,renderedY=(top+h/2)/FRAME.height;layer.x=keepPosition&&Math.abs(renderedX-prior.x)<=.501/FRAME.width?prior.x:renderedX;layer.y=keepPosition&&Math.abs(renderedY-prior.y)<=.501/FRAME.height?prior.y:renderedY;layer.width=w/FRAME.width;
    // SOP 5: judged against the garment under the logo. The recolored file becomes the layer asset: dragging shows it, and the artwork column lists it as this garment color's version.
    const prompt=c.draft.artworks.find(a=>a.id===s.artId)?.prompt,garmentColor=garmentColorUnder(baseRaw,left,top,w,h),analysis=garmentColor&&await logoColorAnalysis(trimmed.bytes);
    const decision=analysis?decideLogoColor(analysis,garmentColor,{setByDesigner:await editRecolorsArtwork(root,s.job),fixedByCustomer:promptFixesLogoColor(prompt)&&(c.entry==='studio'||sourceMentionsColor(c.sourceText,[group.color,...c.draft.artworks.flatMap(a=>a.applications.map(x=>x.color))])),accents:face.accents}):null;let art=trimmed.bytes;
    if(decision?.color){art=await recolorLogo(trimmed.bytes,decision.color);layer.asset=`mockup-assets/logo-${hash(art)}.png`;await atomicFile(assetPath(root,layer.asset),art);}
    layer.colorResult=decision&&{color:decision.color,source:decision.source,blocked:decision.blocked,recommended:{color:decision.recommendation.color,label:decision.recommendation.label}};
    const said=colorMessages(decision);if(said.hint)notes.push(`${s.position}：${said.hint}`);
    const pxPerCm=face.bodyWidth>0?face.bodyWidth/PROJECTED_BODY_WIDTH_CM:null,logo=await sharp(art).resize(w,h).png().toBuffer(),shape=await alphaSamples(logo,w,h);
    // A manual resize is reported as what is now on the garment; an automatic size keeps its exact rule value.
    if(pxPerCm&&(keepSize||!layer.sizeCm))layer.sizeCm={width:w/pxPerCm,height:h/pxPerCm};
    layer.checks=[...(keepPosition&&keepSize?[]:initial.warnings||[]),...[outsideGarment(shape,left,top,face)>.03?'Logo 有部分超出衣服轮廓，请调整位置或尺寸':null,said.warning||await colorIssue(logo,w,h,baseRaw,left,top)].filter(Boolean)];
    if(s.info.defaulted)notes.push(`${s.position}：需求未写明位置，按左前胸放置`);
    if(layer.rule&&!layer.positionManual)notes.push(`${s.position}：${layer.rule}${layer.sizeCm?`，约宽${+layer.sizeCm.width.toFixed(1)}×高${+layer.sizeCm.height.toFixed(1)}厘米`:''}`);
    // SOP 2.2: customer-fixed sizes are written on the mockup; irregular outlines also give the height.
    if(layer.requested&&layer.sizeCm){const withHeight=irregularShape(shape)||!!requestedDimensions(c.draft.artworks.find(a=>a.id===s.artId)?.prompt)?.height;layer.annotation={text:annotationText(layer.sizeCm,withHeight),withHeight,box:{left,top,w,h}};if(!card.annotateSize)notes.push(`${s.position}：客户指定尺寸，${layer.annotation.text}（可在效果图上显示标注）`);}else delete layer.annotation;
    layers.push(layer);composited.push({input:logo,left,top});
   }
   warnings.push(...layerWarnings(layers));
   const overlay=card.annotateSize&&await annotationOverlay(layers.filter(l=>l.annotation).map(l=>l.annotation),FRAME.width,FRAME.height,{left:FRAME.area.x,right:FRAME.area.x+FRAME.area.width,bottom:FRAME.area.y+FRAME.area.height});
   if(overlay)composited.push({input:overlay,left:0,top:0});
   const bytes=await sharp(base.bytes).composite(composited).png().toBuffer(),sha256=hash(bytes),asset=`mockup-results/${card.id}/${sha256}.png`;await atomicFile(assetPath(root,asset),bytes);
   if(card.render&&card.render.sha256!==sha256)state.history.push({cardId:card.id,...card.render});
   card.layers=layers;card.base={asset:baseAsset,sha256:baseHash};card.garment={id:garment.id,style:garment.styleCode,color:garment.colorName,assetVersionId:garment.assetVersionId,sha256:garment.sha256};
   card.render={asset,sha256,bytes:bytes.length,width:FRAME.width,height:FRAME.height,inputHash:renderKey(layers),renderedAt:stamp()};card.warnings=warnings;card.hints=notes;card.status=warnings.length?'preview':'ready';card.note='按效果图SOP放置，尺寸按投影衣身40厘米换算；人工排版保留。';changed=true;
  }catch(e){card.status='failed';card.error=e.message;changed=true;}
 }
 const retained=state.cards.filter(card=>groups.some(g=>g.id===card.id));if(retained.length!==state.cards.length)changed=true;state.cards=retained;
 if(changed){state.revision++;state.updatedAt=stamp();await saveJSON(statePath(root,c.caseId),state);}return state;
}
