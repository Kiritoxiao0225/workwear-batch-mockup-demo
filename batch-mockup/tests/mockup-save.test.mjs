import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlacementWriter} from '../experiments/workbench/mockup-save.mjs';
const initial=()=>({revision:1,cards:[{id:'C',variantId:'V',selections:{left:'A'},layers:[{id:'L',x:.2,y:.3,width:.1}]}]});
const patch=x=>({layers:[{id:'L',x,y:.3,width:.1}]});
const saved=(r,p)=>({revision:r,cards:[{...initial().cards[0],...p}]});
test('连续拖动只串行提交第一处和最新位置；中途不宣称保存完成',async()=>{
 let release;const sent=[],states=[];
 const w=createPlacementWriter({initial:initial(),cardId:'C',read:async()=>initial(),write:b=>{sent.push(b);return sent.length===1?new Promise(r=>release=r):Promise.resolve(saved(3,b));},onChange:s=>states.push(s)});
 const p=w.submit(patch(.4));w.submit(patch(.5));w.submit(patch(.6));
 assert.equal(sent.length,1);assert.ok(states.every(s=>s.pending));release(saved(2,patch(.4)));await p;
 assert.deepEqual(sent.map(b=>[b.revision,b.layers[0].x]),[[1,.4],[2,.6]]);assert.equal(w.snapshot().pending,false);
});
test('合成只更新版本时可回读后重试；其他页面改位置则不得覆盖',async()=>{
 for(const conflict of [false,true]){let calls=0;const current=saved(2,patch(conflict?.8:.2));
 const w=createPlacementWriter({initial:initial(),cardId:'C',read:async()=>current,write:async b=>{calls++;if(calls===1)throw Object.assign(Error('CAS'),{status:409});assert.equal(b.revision,2);return saved(3,b);}});
 await w.submit(patch(.4));assert.equal(calls,conflict?1:2);assert.equal(!!w.snapshot().error,conflict);}
});
test('响应丢失回读已保存位置，不重复写；失败后新拖动仍保留供重试',async()=>{
 let calls=0;const p=patch(.4);const w=createPlacementWriter({initial:initial(),cardId:'C',write:async()=>{calls++;throw Error('lost');},read:async()=>saved(2,p)});await w.submit(p);assert.equal(calls,1);assert.equal(w.snapshot().pending,false);
 let online=false;const sent=[];const q=createPlacementWriter({initial:initial(),cardId:'C',write:async b=>{if(!online)throw Error('offline');sent.push(b);return saved(2,b);},read:async()=>initial()});await q.submit(patch(.5));await q.submit(patch(.7));assert.equal(q.snapshot().pending,true);online=true;await q.retry();assert.equal(sent[0].layers[0].x,.7);assert.equal(q.snapshot().pending,false);
});
