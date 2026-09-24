import {MOCKUP_BODY_WIDTH_CM,defaultPrintSize} from '../../lib/production-sizing.ts';
export const PLACEMENT_POLICY='body-55-bounds-v2';
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
function intersection(a,b){const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),r=Math.min(a.x+a.width,b.x+b.width),d=Math.min(a.y+a.height,b.y+b.height);return r>x&&d>y?{x,y,width:r-x,height:d-y}:null;}
function subtract(area,cut){const hit=intersection(area,cut);if(!hit)return [area];return [
 {x:area.x,y:area.y,width:hit.x-area.x,height:area.height},
 {x:hit.x+hit.width,y:area.y,width:area.x+area.width-hit.x-hit.width,height:area.height},
 {x:area.x,y:area.y,width:area.width,height:hit.y-area.y},
 {x:area.x,y:hit.y+hit.height,width:area.width,height:area.y+area.height-hit.y-hit.height},
 ].filter(r=>r.width>1&&r.height>1);}
export function placementGeometry(face,info,ratio,prompt=''){
 if(!(face.bodyWidth>0))throw Error('无法确定衣身宽度，请在商品素材库确认左右腋点后更新效果图');
 const body=face.bodyWidth,center=face.bodyCenter??face.x+face.width/2,pixelPerCm=body/MOCKUP_BODY_WIDTH_CM;
 const spec=face.standard,p=spec?.positions?.find(p=>p.key===info.key),f=spec?.garmentFrame;
 const project=b=>({x:face.x+((f.x+b.x*f.width)*face.crop.width-face.trim.left)*face.scale,y:face.y+((f.y+b.y*f.height)*face.crop.height-face.trim.top)*face.scale,width:b.width*f.width*face.crop.width*face.scale,height:b.height*f.height*face.crop.height*face.scale});
 let anchor,area,exclusions=[];
 if(p&&f){anchor=project({x:p.anchor.x,y:p.anchor.y,width:0,height:0});area=project(p.printableArea);exclusions=(spec.exclusions||[]).map(e=>project(e.area));}
 else{
  const side=info.key==='leftChest'?1:info.key==='rightChest'?-1:0;
  anchor={x:center+side*body*.25,y:face.y+face.height*(info.key==='upperBack'?.22:info.face==='back'?.38:.34)};
  area=side?{x:center+(side>0?.055:-.445)*body,y:face.y+face.height*.22,width:body*.39,height:face.height*.34}:{x:center-body*.44,y:face.y+face.height*.18,width:body*.88,height:face.height*.7};
 }
 area=intersection(area,{x:face.x,y:face.y,width:face.width,height:face.height});if(!area)throw Error('印花位置标准不在衣服范围内，请在素材库核对');
 let areas=[area];for(const e of exclusions)areas=areas.flatMap(a=>subtract(a,e));if(!areas.length)throw Error('印花区域被领口或拉链占用，请在素材库核对');
 const key=info.face==='back'?'back':info.key,limits=defaultPrintSize({key,catalogPosition:info.key}),requested=requestedDimensions(prompt);
 let width,height,sizeConflict=null;
 if(requested){
  width=requested.width??requested.height/ratio;height=requested.height??width*ratio;
  // Customer sizes are often rounded; keep the width and scale proportionally instead of stretching the logo.
  if(requested.width&&requested.height&&Math.abs(height/width-ratio)/ratio>.05){sizeConflict={width:requested.width,height:requested.height};height=width*ratio;}
 }else{width=Math.min(limits.width,limits.height/ratio);height=width*ratio;}
 if(!(width>0&&height>0&&width<=55&&height<=100))throw Error('图稿尺寸超出支持范围，请核对厘米数值');
 const desired={width:width*pixelPerCm,height:height*pixelPerCm};
 const choices=areas.map(a=>{const scale=Math.min(1,a.width/desired.width,a.height/desired.height);const w=desired.width*scale,h=desired.height*scale;const x=clamp(anchor.x,a.x+w/2,a.x+a.width-w/2),y=clamp(anchor.y,a.y+h/2,a.y+a.height-h/2);return {x,y,width:w,height:h,fit:scale,distance:Math.hypot(x-anchor.x,y-anchor.y),area:a};}).sort((a,b)=>b.fit-a.fit||a.distance-b.distance);
 const chosen=choices[0];if(requested&&chosen.fit<.999)throw Error('客户指定尺寸超出可印区域，未擅自缩小，请核对位置与尺寸');
 return {...chosen,requested:!!requested,sizeConflict,policy:PLACEMENT_POLICY,sizeCm:{width:chosen.width/pixelPerCm,height:chosen.height/pixelPerCm},basis:face.bodyBasis,standard:!!p};
}
