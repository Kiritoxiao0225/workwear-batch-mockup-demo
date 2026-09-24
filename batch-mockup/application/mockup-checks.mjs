import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {judgeLogoColors} from '../../lib/logo-color-sop.ts';
import {colorProblem,garmentColorUnder,logoColorAnalysis} from './mockup-color.mjs';
const FONT='MockupNote';let fontReady=false;
function ensureFont(){if(fontReady)return;if(!GlobalFonts.registerFromPath(fileURLToPath(new URL('../../public/fonts/DOUYINSANSBOLD.TTF',import.meta.url)),FONT))throw Error('效果图标注字体加载失败');fontReady=true;}
/** Downsampled alpha of a placed image, used for garment coverage and logo shape. */
export async function alphaSamples(bytes,width,height,step=4){
 const w=Math.max(1,Math.ceil(width/step)),h=Math.max(1,Math.ceil(height/step));
 const {data}=await sharp(bytes).resize(w,h,{fit:'fill'}).ensureAlpha().extractChannel(3).raw().toBuffer({resolveWithObject:true});
 return {data,width:w,height:h,step};
}
// Outline fill per row: text lines fill their bounding box, diamonds and badges do not.
export function irregularShape(alpha){
 let filled=0;for(let y=0;y<alpha.height;y++){let a=-1,b=-1;for(let x=0;x<alpha.width;x++)if(alpha.data[y*alpha.width+x]>=128){if(a<0)a=x;b=x;}if(a>=0)filled+=b-a+1;}
 return filled/(alpha.width*alpha.height)<.8;
}
/** Share of logo pixels that land outside the garment silhouette. */
export function outsideGarment(logo,left,top,face){
 const g=face.garmentAlpha;if(!g)return 0;let total=0,out=0;
 for(let y=0;y<logo.height;y++)for(let x=0;x<logo.width;x++){if(logo.data[y*logo.width+x]<128)continue;total++;
  const gx=Math.floor((left+x*logo.step-face.x)/g.step),gy=Math.floor((top+y*logo.step-face.y)/g.step);
  if(gx<0||gy<0||gx>=g.width||gy>=g.height||g.data[gy*g.width+gx]<128)out++;}
 return total?out/total:0;
}
/** SOP 5: the logo as placed, judged against the garment under it. Only reports; recoloring is decided in mockups. */
export async function colorIssue(logoBytes,w,h,baseRaw,left,top){
 const garment=garmentColorUnder(baseRaw,left,top,w,h),analysis=garment&&await logoColorAnalysis(logoBytes);
 if(!analysis)return null;
 const verdict=judgeLogoColors(analysis,garment);
 if(verdict.ok)return null;
 return verdict.reason==='clash'?`${colorProblem(verdict)}；SOP 建议改用低饱和大面积配小面积点缀，请核对颜色`:`${colorProblem(verdict)}；SOP：深色衣服配浅色 Logo、浅色衣服配深色 Logo，请核对颜色`;
}
const cm=v=>`${+v.toFixed(1)}cm`;
/** SOP 2.2: when the customer fixed a size, the mockup states it; irregular logos also state the height. */
export function annotationText(sizeCm,withHeight){return withHeight?`Logo 最大宽度：${cm(sizeCm.width)}　最大高度：${cm(sizeCm.height)}`:`Logo 宽度：${cm(sizeCm.width)}`;}
export async function annotationOverlay(items,width,height,limit){
 if(!items.length)return null;ensureFont();
 const canvas=createCanvas(width,height),g=canvas.getContext('2d'),red='#c8102e';
 g.font=`40px ${FONT}`;g.textBaseline='middle';g.lineWidth=4;g.strokeStyle=red;
 const line=(x0,y0,x1,y1)=>{g.beginPath();g.moveTo(x0,y0);g.lineTo(x1,y1);g.stroke();};const placed=[];
 for(const a of items){
  const {left,top,w,h}=a.box,pillH=62,below=top+h+30+pillH+12<=limit.bottom,yy=below?top+h+22:top-22;
  line(left,yy,left+w,yy);line(left,yy-14,left,yy+14);line(left+w,yy-14,left+w,yy+14);
  if(a.withHeight){const xx=left+w+22;line(xx,top,xx,top+h);line(xx-14,top,xx+14,top);line(xx-14,top+h,xx+14,top+h);}
  const tw=g.measureText(a.text).width+36,cx=Math.max(limit.left+tw/2,Math.min(limit.right-tw/2,left+w/2));let cy=below?yy+14+pillH/2:yy-14-pillH/2;
  // Labels of neighbouring logos (chest and sleeve) must not cover each other.
  const hit=y=>placed.some(r=>Math.abs(r.cx-cx)<(r.tw+tw)/2+8&&Math.abs(r.cy-y)<pillH+8);
  for(let n=0;n<6&&hit(cy);n++)cy+=(below?1:-1)*(pillH+10);
  placed.push({cx,cy,tw});
  g.fillStyle='#ffffffee';g.beginPath();g.roundRect(cx-tw/2,cy-pillH/2,tw,pillH,12);g.fill();g.stroke();
  g.fillStyle=red;g.textAlign='center';g.fillText(a.text,cx,cy+2);
 }
 return canvas.encode('png');
}
