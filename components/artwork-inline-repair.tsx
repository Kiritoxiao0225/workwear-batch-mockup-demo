import {useCallback,useEffect,useRef,useState,type PointerEvent} from 'react';
import {applyRepairStroke,type RepairStroke,type RepairPoint} from '../batch-mockup/application/repair-pixels.mjs';
import {artworkGraphicFrame,type ArtworkGraphicLayer} from '@/lib/artwork-editor';
import {loadArtworkImage} from '@/lib/client/render-artwork';
import {recolorArtworkPixels} from '@/lib/artwork-layers';
import {spreadArtworkInk} from '@/lib/artwork-ink-spread';

export type RepairTool='fill'|'keep'|'remove';
type RepairData={w:number;h:number;work:HTMLCanvasElement;current:Uint8ClampedArray;source:Uint8ClampedArray;mask?:Uint8ClampedArray;canRestore:boolean};
type BrushStroke={mode:'keep'|'remove';radius:number;last:RepairPoint;changed:boolean};
type Props={graphic:ArtworkGraphicLayer;originalURL?:string;mode:RepairTool;scope:'region'|'brush';radius:number;displayWidth:number;displayHeight:number;onCommit:(url:string)=>void;onStatus:(text:string)=>void;onReady:(canRestore:boolean)=>void};

// Paint directly into the selected layer; the parent owns the common undo/save history.
export function InlineRepair({graphic,originalURL,mode,scope,radius,displayWidth,displayHeight,onCommit,onStatus,onReady}:Props){
 const canvas=useRef<HTMLCanvasElement>(null),data=useRef<RepairData|null>(null),stroke=useRef<BrushStroke|null>(null),emitted=useRef<string|null>(null);
 const callbacks=useRef({onCommit,onStatus,onReady});useEffect(()=>{callbacks.current={onCommit,onStatus,onReady};});
 const [cursor,setCursor]=useState<{x:number;y:number}|null>(null),[ready,setReady]=useState(false),[rasterWidth,setRasterWidth]=useState(1);
 const config=useRef(graphic);useEffect(()=>{config.current=graphic;});
 const frame=artworkGraphicFrame(graphic);
 const draw=useCallback(()=>{
  const d=data.current,c=canvas.current,g=config.current;if(!d||!c)return;
  const color=g.recolor.mode==='solid'&&(g.recolorScope==='visible'||d.mask)?g.recolor.color:null;
  const pixels=color?recolorArtworkPixels(new Uint8ClampedArray(d.current),color,g.recolorScope==='visible'?undefined:d.mask):d.current;
  d.work.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels),d.w,d.h),0,0);
  const crop=g.sourceBounds??{left:0,top:0,width:d.w,height:d.h},spread=g.inkSpread??0,f=artworkGraphicFrame(g);
  c.width=spread?Math.ceil(f.width*2):crop.width;c.height=spread?Math.ceil(f.height*2):crop.height;
  const ctx=c.getContext('2d',{willReadFrequently:true})!;
  if(!spread)ctx.drawImage(d.work,-crop.left,-crop.top);
  else{const sx=c.width/f.width,sy=c.height/f.height;ctx.drawImage(d.work,crop.left,crop.top,crop.width,crop.height,spread*sx,spread*sy,g.width*sx,g.height*sy);const p=ctx.getImageData(0,0,c.width,c.height);p.data.set(spreadArtworkInk(p.data,c.width,c.height,spread*sx,spread*sy));ctx.putImageData(p,0,0);}
 },[]);
 useEffect(()=>{
  if(emitted.current===graphic.sourceUrl&&data.current){draw();return;}
  emitted.current=null;let alive=true;setReady(false);callbacks.current.onReady(false);
  (async()=>{
   const img=await loadArtworkImage(graphic.sourceUrl);if(!alive)return;
   const w=img.naturalWidth,h=img.naturalHeight;if(w*h>16_000_000)throw Error('当前修补最多支持1600万像素的图层');
   const work=document.createElement('canvas');work.width=w;work.height=h;const ctx=work.getContext('2d',{willReadFrequently:true})!;ctx.drawImage(img,0,0);
   const current=new Uint8ClampedArray(ctx.getImageData(0,0,w,h).data);let source:Uint8ClampedArray=current,canRestore=false,mask:Uint8ClampedArray|undefined;
   if(originalURL&&!graphic.sourceBounds){const raw=await loadArtworkImage(originalURL);if(!alive)return;if(raw.naturalWidth===w&&raw.naturalHeight===h){ctx.clearRect(0,0,w,h);ctx.drawImage(raw,0,0);source=new Uint8ClampedArray(ctx.getImageData(0,0,w,h).data);canRestore=true;}}
   if(graphic.recolorMaskUrl){const m=await loadArtworkImage(graphic.recolorMaskUrl);if(!alive)return;ctx.clearRect(0,0,w,h);ctx.drawImage(m,0,0,w,h);mask=ctx.getImageData(0,0,w,h).data;}
   data.current={w,h,work,current,source,mask,canRestore};setRasterWidth(w);setReady(true);callbacks.current.onReady(canRestore);draw();
  })().catch(e=>{if(alive)callbacks.current.onStatus(e.message);});return()=>{alive=false;};
 },[graphic.sourceUrl,originalURL,graphic.sourceBounds,graphic.recolorMaskUrl,draw]);
 useEffect(()=>{draw();},[graphic.recolor.mode,graphic.recolor.color,graphic.recolorScope,graphic.inkSpread,graphic.width,graphic.height,draw]);
 const point=(e:PointerEvent):RepairPoint=>{
  const d=data.current!,r=canvas.current!.getBoundingClientRect(),a=graphic.rotation*Math.PI/180,dx=e.clientX-r.left-r.width/2,dy=e.clientY-r.top-r.height/2;
  const nx=(Math.cos(a)*dx+Math.sin(a)*dy)/displayWidth+.5,ny=(-Math.sin(a)*dx+Math.cos(a)*dy)/displayHeight+.5;
  setCursor({x:nx,y:ny});
  const crop=graphic.sourceBounds??{left:0,top:0,width:d.w,height:d.h},spread=graphic.inkSpread??0;
  const x=crop.left+(nx*frame.width-spread)/graphic.width*crop.width,y=crop.top+(ny*frame.height-spread)/graphic.height*crop.height;
  return [Math.max(0,Math.min(d.w-1,x)),Math.max(0,Math.min(d.h-1,y))];
 };
 function apply(value:RepairStroke){const d=data.current!;try{const result=applyRepairStroke(d.current,d.source,d.current,d.w,d.h,value);draw();callbacks.current.onStatus(value.mode==='fill'?`已补回${scope==='region'?'整块空洞':'圈内空白'} · ${(result?.restoredPixels??0).toLocaleString()} 个像素`:value.mode==='keep'?'已恢复画笔经过的原图内容':'已去除画笔经过的区域');return true;}catch(e){callbacks.current.onStatus(e instanceof Error?e.message:String(e));return false;}}
 function commit(){const d=data.current!;d.work.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(d.current),d.w,d.h),0,0);const url=d.work.toDataURL('image/png');emitted.current=url;callbacks.current.onCommit(url);}
 function down(e:PointerEvent<HTMLCanvasElement>){e.stopPropagation();e.preventDefault();if(!ready||e.button!==0)return;
  const d=data.current!;if(mode!=='remove'&&!d.canRestore){callbacks.current.onStatus('这个图层没有对应的抠图前原图，可使用去除笔。');return;}
  e.currentTarget.focus({preventScroll:true});const p=point(e);e.currentTarget.setPointerCapture(e.pointerId);
  if(mode==='fill'){if(apply({mode,scope,point:p,...(scope==='brush'?{radius}:{})}))commit();return;}
  stroke.current={mode,radius,last:p,changed:apply({mode,radius,points:[p]})};
 }
 function move(e:PointerEvent<HTMLCanvasElement>){e.stopPropagation();if(!ready)return;const p=point(e),s=stroke.current;if(s){s.changed=apply({mode:s.mode,radius:s.radius,points:[s.last,p]})||s.changed;s.last=p;}}
 function end(e:PointerEvent<HTMLCanvasElement>){e.stopPropagation();const s=stroke.current;stroke.current=null;if(s?.changed)commit();}
 const cropWidth=graphic.sourceBounds?.width??rasterWidth;
 return <><canvas ref={canvas} className="inline-repair-canvas" aria-label="直接修补当前图层" tabIndex={0} style={{cursor:mode==='fill'&&scope==='region'?'crosshair':'none'}} onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={()=>setCursor(null)}/>{cursor&&!(mode==='fill'&&scope==='region')&&<i className={'repair-brush-cursor '+mode} style={{left:cursor.x*100+'%',top:cursor.y*100+'%',width:radius*2/cropWidth*(graphic.width/frame.width)*100+'%',aspectRatio:'1'}}/>}</>;
}
