import { test, expect } from 'vitest';
import sharp from 'sharp';
import { callGarmentModel, GARMENT_MODELS } from './garment-mockup-provider';
const env={ARK_RUNTIME_API_KEY:'test-ark',VOLCENGINE_ACCESS_KEY:'test-access',VOLCENGINE_SECRET_KEY:'test-secret'};
const png=async()=>sharp({create:{width:2,height:1,channels:4,background:{r:180,g:30,b:60,alpha:1}}}).png().toBuffer();
test('back uses the original Seedream model, exact size and one paid request',async()=>{
 const bytes=await png(),data='data:image/png;base64,'+bytes.toString('base64');let paid=0;const requests:{url:string;body:Record<string,unknown>}[]=[];
 const result=await callGarmentModel('back',{instruction:'',images:[],base64Image:data},{env,beforeSubmit:async()=>{paid++;},receipt:async()=>{},fetchImplementation:async(url,init)=>{
  if(init?.method==='POST'){requests.push({url:String(url),body:JSON.parse(String(init.body))});return Response.json({data:[{url:'https://example.test/back.png'}]});}return new Response(new Uint8Array(bytes));
 }});
 expect(paid).toBe(1);expect(requests[0].url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
 expect(requests[0].body).toMatchObject({model:'doubao-seedream-5-0-260128',size:'1920x1920',image:data,watermark:false});
 expect(result.model).toBe(GARMENT_MODELS.back.model);
});
test('cutout uses original CV saliency mask, preserves original pixels and dimensions',async()=>{
 const bytes=await png(),mask=await sharp(Buffer.from([0,255]),{raw:{width:2,height:1,channels:1}}).png().toBuffer();let paid=0;
 const result=await callGarmentModel('cutout',{instruction:'',images:[],base64Image:'data:image/png;base64,'+bytes.toString('base64')},{env,beforeSubmit:async()=>{paid++;},receipt:async()=>{},fetchImplementation:async(url,init)=>{
  expect(String(url)).toBe('https://visual.volcengineapi.com/?Action=CVProcess&Version=2022-08-31');
  expect(JSON.parse(String(init?.body))).toEqual({req_key:'saliency_seg',binary_data_base64:[bytes.toString('base64')],only_mask:1,refine_mask:1});
  expect((init?.headers as Record<string,string>).Authorization).toContain('cn-north-1/cv/request');
  return Response.json({code:10000,data:{binary_data_base64:[mask.toString('base64')]}});
 }});
 expect(paid).toBe(1);expect('mask' in result).toBe(true);if(!('mask'in result))throw new Error('No mask');expect(result.original).toEqual(bytes);
 const out=await sharp(result.bytes).raw().toBuffer({resolveWithObject:true});expect(out.info.width).toBe(2);expect([...out.data]).toEqual([180,30,60,0,180,30,60,255]);
});
test('missing CV credentials fails before submitting and never switches provider',async()=>{
 let calls=0;await expect(callGarmentModel('cutout',{instruction:'',images:[]},{env:{},beforeSubmit:async()=>{calls++;},receipt:async()=>{},fetchImplementation:async()=>{throw new Error('must not fetch');}})).rejects.toThrow('VOLCENGINE_ACCESS_KEY');expect(calls).toBe(0);
});
test('understanding stays on original Doubao despite other page model settings',async()=>{
 let calls=0;await expect(callGarmentModel('understand',{instruction:'测试',images:[]},{env:{...env,VISION_MODEL_EP:'another-page',MOCKUP_LOGO_ANALYSIS_MODEL:'another-model'},beforeSubmit:async()=>{calls++;},receipt:async()=>{},fetchImplementation:async(url,init)=>{
  const body=JSON.parse(String(init?.body));expect(body.model).toBe('doubao-seed-2-0-lite-260215');expect(body.temperature).toBe(.1);expect(body.max_tokens).toBe(2000);expect(body.reasoning_effort).toBeUndefined();return new Response('{}',{status:429});
 }})).rejects.toThrow();expect(calls).toBe(1);
});
