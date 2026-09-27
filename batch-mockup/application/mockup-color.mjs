import sharp from 'sharp';
import {analyzeLogoColors,fromHex} from '../../lib/logo-color-sop.ts';
import {recolorArtworkPixels} from '../../lib/artwork-layers.ts';
const ratio=v=>`${+v.toFixed(1)}:1`;
/** Colors of a logo at a fixed analysis size, so the same artwork gets the same decision on every garment. */
export async function logoColorAnalysis(bytes){
 const {data,info}=await sharp(bytes).resize(320,320,{fit:'inside',withoutEnlargement:true}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 return analyzeLogoColors(data,info.width,info.height);
}
/** The garment under a logo box: the pixel of median lightness, so folds and highlights do not decide. */
export function garmentColorUnder(baseRaw,left,top,w,h){
 const samples=[];
 for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){const X=left+x,Y=top+y;if(X<0||Y<0||X>=baseRaw.info.width||Y>=baseRaw.info.height)continue;const i=(Y*baseRaw.info.width+X)*baseRaw.info.channels,r=baseRaw.data[i],g=baseRaw.data[i+1],b=baseRaw.data[i+2];samples.push([.2126*r+.7152*g+.0722*b,[r,g,b]]);}
 if(!samples.length)return null;
 return samples.sort((a,b)=>a[0]-b[0])[samples.length>>1][1];
}
/** The same pixel recolor as the artwork editor's layer color: every visible pixel takes the color, alpha unchanged. */
export async function recolorLogo(bytes,color){
 fromHex(color);
 const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const out=recolorArtworkPixels(new Uint8ClampedArray(data.buffer,data.byteOffset,data.length),color);
 return sharp(Buffer.from(out.buffer,out.byteOffset,out.length),{raw:{width:info.width,height:info.height,channels:4}}).png().toBuffer();
}
export function colorProblem(verdict){
 return verdict.reason==='clash'?'Logo 与衣服为高饱和撞色，容易刺眼、显得不专业':`Logo 与衣服颜色深浅接近（对比约${ratio(verdict.contrast)}），3 米外可能看不清`;
}
/** What the designer reads for one layer: a hint when the SOP recolored it, a warning when it still fails and was left alone. */
export function colorMessages(decision){
 if(!decision)return {};
 const {verdict,recommendation:rec,source,blocked}=decision;
 if(source==='auto')return {hint:`${colorProblem(verdict)}，已按 SOP 改为${rec.label}${['图稿原有色','衣服撞色'].includes(rec.label)?' '+rec.color:''}（对比约${ratio(rec.contrast)}），图稿列有这个颜色的版本可下载。需要其他颜色时，在图稿编辑器里设置图层颜色`};
 if(blocked==='customer')return {warning:`${colorProblem(verdict)}；图稿写明了颜色要求，未自动改色；建议改为${rec.label}，可在图稿编辑器里设置图层颜色`};
 if(blocked==='multi-color')return {warning:`${colorProblem(verdict)}；图稿有多种颜色，整体改成单色会失去原有配色，未自动改色；如需更醒目，可在图稿编辑器里调整部分颜色`};
 // The designer chose the original colours for this position; say so without calling it a problem.
 if(blocked==='kept')return {hint:`按你的选择使用原图颜色${verdict.ok?'':`（与衣服对比约${ratio(verdict.contrast)}）`}`};
 if(blocked==='inner-detail')return {warning:`${colorProblem(verdict)}；图稿内部有深浅分区（如白字、未去净的白底），整体改成单色会丢细节，未自动改色。请在图稿编辑器用“去空白”或“选区颜色”处理，或直接设置图层颜色`};
 return {};
}
