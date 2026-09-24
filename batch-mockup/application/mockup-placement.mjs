import {PROJECTED_BODY_WIDTH_CM,SOP_PLACEMENT_POLICY,sopPlacement,sopPrintSize} from '../../lib/sop-placement.ts';
export const PLACEMENT_POLICY=SOP_PLACEMENT_POLICY;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
// Only the explicit size section of the designer's saved requirement is read.
export function requestedDimensions(prompt=''){
 const text=prompt.match(/(?:^|\n)尺寸[：:]([^]*?)(?=\n输出[：:]|$)/)?.[1]||'';
 const pair=text.match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)\s*(厘米|公分|cm|毫米|mm)/i);
 const factor=u=>/毫米|mm/i.test(u)?.1:1;
 if(pair)return {width:Number(pair[1])*factor(pair[3]),height:Number(pair[2])*factor(pair[3]),explicit:true};
 const dim={};for(const m of text.matchAll(/(宽|高)(?:度)?[：:\s]*(\d+(?:\.\d+)?)\s*(厘米|公分|cm|毫米|mm)/gi))dim[m[1]==='宽'?'width':'height']=Number(m[2])*factor(m[3]);
 if(Object.keys(dim).length)return {...dim,explicit:true};
 if(/\d/.test(text)&&/宽|高|厘米|公分|cm|毫米|mm|×/i.test(text))throw Error('图稿尺寸未能明确换算，请在尺寸栏写清宽或高及厘米单位');
 return null;
}
// A customer size wider than this cannot stay in its position (a chest logo would cross the center line).
const REQUESTED_MAX_WIDTH={leftChest:20,rightChest:20,leftSleeve:12,rightSleeve:12,upperBack:30,backCenter:PROJECTED_BODY_WIDTH_CM,frontCenter:PROJECTED_BODY_WIDTH_CM};
// Last resort when neither a confirmed standard nor a silhouette measurement exists.
export function fallbackStructure(face){
 const c=face.bodyCenter??face.x+face.width/2,b=face.bodyWidth,span=face.height*.43,top=face.y;
 return {structureType:'unknown',neck:{x:c,y:top+span*(face.face==='back'?.07:.25)},leftShoulder:{x:c-b*.55,y:top+span*.3},rightShoulder:{x:c+b*.55,y:top+span*.3},leftArmpit:{x:c-b/2,y:top+span},rightArmpit:{x:c+b/2,y:top+span},bodyWidth:b,center:c,bounds:{x:face.x,y:face.y,width:face.width,height:face.height},exclusions:[]};
}
// Width (px) from a sleeve logo's inner edge to the sleeve outline on that row, from the placed garment alpha.
function sleeveRoom(face,y,inner,side){
 const g=face.garmentAlpha;if(!g)return null;const row=Math.floor((y-face.y)/g.step);if(row<0||row>=g.height)return null;
 let x=Math.floor((inner-face.x)/g.step);if(x<0||x>=g.width||g.data[row*g.width+x]<128)return null;
 while(x+side>=0&&x+side<g.width&&g.data[row*g.width+x+side]>=128)x+=side;
 return Math.abs(face.x+(x+(side>0?1:0))*g.step-inner);
}
export function placementGeometry(face,info,ratio,prompt='',{sizeReference=null}={}){
 if(!(face.bodyWidth>0))throw Error('无法确定衣身宽度，请在商品素材库确认左右腋点后更新效果图');
 const structure={...(face.structure||fallbackStructure(face)),bodyWidth:face.bodyWidth},pixelPerCm=face.bodyWidth/PROJECTED_BODY_WIDTH_CM;
 const requested=requestedDimensions(prompt);
 let width,height,sizeConflict=null;
 if(requested){
  width=requested.width??requested.height/ratio;height=requested.height??width*ratio;
  // Customer sizes are often rounded; keep the width and scale proportionally instead of stretching the logo.
  if(requested.width&&requested.height&&Math.abs(height/width-ratio)/ratio>.05){sizeConflict={width:requested.width,height:requested.height};height=width*ratio;}
 }else({width,height}=sopPrintSize(info.key,ratio));
 // SOP 2.1: without a customer size, a reference photo's logo-to-body ratio sets the width (a soft basis, never annotated).
 let referenceRule='',referenceWarning=null;
 if(!requested&&sizeReference){const w=sizeReference.logoToBody*PROJECTED_BODY_WIDTH_CM;
  if(w<=REQUESTED_MAX_WIDTH[info.key]){width=w;height=w*ratio;referenceRule=`尺寸按参考图比例（${sizeReference.note||`约占衣身宽${Math.round(sizeReference.logoToBody*100)}%`}）；`;}
  else referenceWarning=`参考图比例换算后宽约${+w.toFixed(1)}厘米，超出该位置可印范围，已按SOP默认尺寸，请核对`;}
 if(!(width>0&&height>0&&width<=55&&height<=100))throw Error('图稿尺寸超出支持范围，请核对厘米数值');
 if(requested&&width>REQUESTED_MAX_WIDTH[info.key])throw Error('客户指定尺寸超出可印区域，未擅自缩小，请核对位置与尺寸');
 let placed=sopPlacement(structure,info.key,{width,height},pixelPerCm);const warnings=[...placed.conflict?[placed.conflict]:[],...referenceWarning?[referenceWarning]:[]];
 // Seen from the front a sleeve is narrow, especially a long one hanging down: keep the seam gap and fit the logo inside the sleeve outline.
 const side=info.key==='leftSleeve'?1:info.key==='rightSleeve'?-1:0,room=side&&sleeveRoom(face,placed.y,placed.x-side*width*pixelPerCm/2,side);
 if(room&&width*pixelPerCm>room-.5*pixelPerCm){
  if(requested)warnings.push('客户指定尺寸宽于正面可见的袖子，请核对尺寸或改在袖子单独展示');
  else{const fit=Math.max(.3,(room-.5*pixelPerCm)/(width*pixelPerCm));width*=fit;height*=fit;placed={...sopPlacement(structure,info.key,{width,height},pixelPerCm),rule:placed.rule+'，按正面可见袖宽缩小'};}
 }
 let w=width*pixelPerCm,h=height*pixelPerCm;
 // A default size never leaves the garment photo; a customer size is kept and reported.
 const fit=Math.min(1,face.width/w,face.height/h);
 if(fit<1){if(requested)warnings.push('客户指定尺寸超出衣服图片范围，请核对尺寸');else{w*=fit;h*=fit;width*=fit;height*=fit;}}
 const x=clamp(placed.x,face.x+Math.min(w,face.width)/2,face.x+face.width-Math.min(w,face.width)/2),y=clamp(placed.y,face.y+Math.min(h,face.height)/2,face.y+face.height-Math.min(h,face.height)/2);
 return {x,y,width:w,height:h,requested:!!requested,sizeConflict,policy:PLACEMENT_POLICY,sizeCm:{width,height},basis:face.bodyBasis,standard:['confirmed','shared'].includes(face.structureSource),structureSource:face.structureSource||'fallback',rule:referenceRule+placed.rule,referenced:!!referenceRule,warnings};
}
