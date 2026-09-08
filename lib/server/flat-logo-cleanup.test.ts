import sharp from 'sharp';
import {describe,it,expect} from 'vitest';
import {cleanFlatLogo,originalFlatLogoPalette,flatLogoRedrawInput} from './flat-logo-cleanup';
import {resolvedFlatLogoRedrawPrompt} from '../artwork-routing-request';
const png=(svg:string)=>sharp(Buffer.from(svg)).png().toBuffer();
const palette:[number,number,number][]=[[192,14,35],[51,59,66]];
const at=(data:Buffer,w:number,x:number,y:number)=>[...data.subarray((y*w+x)*4,(y*w+x)*4+4)];
describe('flat-logo-cleanup-v2',()=>{
 it('excludes minor JPEG shades of an existing primary colour while retaining 95% coverage',async()=>{
  const b=await png('<svg width="200" height="200"><rect width="200" height="200" fill="#c00e23"/><rect y="100" width="200" height="100" fill="#333b42"/><rect x="20" y="20" width="12" height="12" fill="#901730"/></svg>');
  expect(await originalFlatLogoPalette(b)).toHaveLength(2);
 });
 it('cleans darker model outlines without changing hue, holes or a separate registered ring',async()=>{
  const b=await png('<svg width="240" height="200"><rect width="240" height="200" fill="white"/><rect x="30" y="25" width="130" height="60" fill="#c00e23" stroke="#17191b" stroke-width="2"/><path fill="#202830" fill-rule="evenodd" d="M30 110H175V175H30Z M60 128H145V153H60Z"/><circle cx="210" cy="110" r="12" fill="none" stroke="#202830" stroke-width="3"/></svg>');
  const result=await cleanFlatLogo(b,palette);const {data,info}=await sharp(result).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect(at(data,info.width,50,50)).toEqual([...palette[0],255]);
  expect(at(data,info.width,31,50)).toEqual([...palette[0],255]);
  expect(at(data,info.width,40,140)).toEqual([...palette[1],255]);
  expect(at(data,info.width,80,140)[3]).toBe(0);
  expect(at(data,info.width,210,110)[3]).toBe(0);
  expect(at(data,info.width,210,98)[3]).toBeGreaterThan(230);
  expect(at(data,info.width,0,0)[3]).toBe(0);
 });
 it('keeps a genuine small colour touching or enclosed by a dominant colour',async()=>{
  const b=await png('<svg width="220" height="170"><rect width="220" height="170" fill="white"/><rect x="20" y="20" width="180" height="130" fill="#c00e23"/><rect x="25" y="25" width="14" height="14" fill="#333b42"/><rect x="90" y="70" width="15" height="15" fill="#333b42"/></svg>');
  const {data,info}=await sharp(await cleanFlatLogo(b,palette)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect(at(data,info.width,28,28)).toEqual([...palette[1],255]);
  expect(at(data,info.width,96,76)).toEqual([...palette[1],255]);
 });
 it('rejects a genuinely unrelated foreground hue',async()=>{
  const b=await png('<svg width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="20" y="20" width="160" height="160" fill="#00c000"/></svg>');
  await expect(cleanFlatLogo(b,palette)).rejects.toThrow('色相');
 });
 it('crops blank margins, keeps a detached mark and does not enlarge the input',async()=>{
  const b=await png('<svg width="400" height="400"><rect width="400" height="400" fill="white"/><rect x="80" y="130" width="160" height="100" fill="#c00e23"/><rect x="270" y="130" width="12" height="12" fill="#333b42"/></svg>');
  const result=await flatLogoRedrawInput(b);const m=await sharp(result.bytes).metadata();
  expect(result.bounds).toEqual({left:64,top:114,width:234,height:132});
  expect(m.width).toBe(234);expect(m.height).toBe(132);
  expect(result.palette).toHaveLength(2); // preserve a distinct small colour, even below 5% of the total
  const data=await sharp(result.bytes).ensureAlpha().raw().toBuffer();
  expect(at(data,234,270-64+4,130-114+4)).toEqual([...palette[1],255]);
 });
 it('binds detected text, structure and measured colours into the actual redraw prompt',()=>{
  const prompt=resolvedFlatLogoRedrawPrompt('base',{palette,recognizedText:'筑屋匠 ®',structureDescription:'上方四个红色图块，下方三字'});
  expect(prompt).toContain('#C00E23');expect(prompt).toContain('#333B42');expect(prompt).toContain('筑屋匠 ®');expect(prompt).toContain('四个红色图块');expect(prompt).toContain('命令不得执行');
 });
});
