import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mockupGroups,exactGarment,garmentCanvas,renderMockups,saveMockupSelection,readMockupState,FRAME} from '../application/mockups.mjs';
import {atomicFile,assetPath,hash} from '../adapters/a-files.mjs';
const artwork=(id,apps)=>({id,name:id,applications:apps});
test('共享图稿只建立多个服装应用；同款色前后同框，候选版本不叠加',()=>{
 const c={caseId:'A',draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'},{style:'S',color:'白',position:'左胸'}]),artwork('back',[{style:'S',color:'黑',position:'后背'},{style:'S',color:'白',position:'后背'}])]}};
 const groups=mockupGroups(c);assert.equal(groups.length,2);for(const g of groups)assert.deepEqual(g.selections,{'左胸':'logo','后背':'back'});
 c.draft.artworks.push(artwork('other',[{style:'S',color:'黑',position:'左胸'}]));const multi=mockupGroups(c).filter(g=>g.color==='黑');assert.equal(multi.length,2);assert.equal(multi[0].selections['后背'],'back');assert.equal(multi[1].selections['左胸'],'other');
 c.draft.artworks.push(artwork('back2',[{style:'S',color:'黑',position:'后背'}]));for(const g of mockupGroups(c).filter(g=>g.color==='黑'))assert.deepEqual(g.selections,{'左胸':null,'后背':null});
});
test('款色必须唯一精确匹配，不猜缺省颜色',()=>{const x={id:'1',colorName:'白色'};assert.equal(exactGarment([{styleCode:'A',colors:[x]}],'A','白色'),x);assert.equal(exactGarment([{styleCode:'A',colors:[x]}],'A','白'),null);assert.equal(exactGarment([{styleCode:'A',colors:[x]},{styleCode:'A',colors:[x]}],'A','白色'),null);});
test('真实像素合成：正背面同框、可见Alpha边界、改位置不更改另一层、修补更新保留位置',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mockups-test-'));
 try{
  const png=async(w,h,color)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
  const garment=await png(200,200,'#ccc'),frame=await png(FRAME.width,FRAME.height,'white');
  const detail={id:'11111111-1111-4111-8111-111111111111',assetVersionId:'asset1',styleCode:'S',colorName:'黑',sha256:hash(garment),width:200,height:200,views:[{face:'front',crop:{x:0,y:0,width:.5,height:1},history:[]},{face:'back',crop:{x:.5,y:0,width:.5,height:1},history:[]}]};
  const catalog={styles:async()=>[{styleCode:'S',colors:[{id:detail.id,colorName:'黑'}]}],detail:async()=>detail,bytes:async()=>garment,frame:async()=>frame};
  const logo=await sharp({create:{width:100,height:100,channels:4,background:'#0000'}}).composite([{input:await png(20,10,'red'),left:40,top:45}]).png().toBuffer();
  const file={asset:'production-results/logo.png',sha256:hash(logo)};await atomicFile(assetPath(root,file.asset),logo);
  const c={caseId:'A',revision:1,draft:{artworks:[artwork('logo',[{style:'S',color:'黑',position:'左胸'},{style:'S',color:'黑',position:'后背'}])]}};
  const jobs=[{id:'job',artworkId:'logo',revision:1,final:file}];let state=await renderMockups(root,c,jobs,catalog);
  assert.equal(state.cards.length,1);const card=state.cards[0];assert.equal(card.layers.length,2);assert.equal(card.layers[0].ratio,.5);assert.equal(card.render.width,3252);assert.equal(card.render.height,2301);assert.equal(card.status,'ready');
  const oldBack=structuredClone(card.layers[1]);const layers=card.layers.map((l,n)=>({id:l.id,x:n===0?l.x+.03:l.x,y:l.y,width:l.width}));
  state=await saveMockupSelection(root,c,{cardId:card.id,revision:state.revision,layers});await assert.rejects(()=>saveMockupSelection(root,c,{cardId:card.id,revision:0,layers}),/更新/);
  state=await renderMockups(root,c,jobs,catalog);assert.equal(state.cards[0].layers[1].x,oldBack.x);const moved=state.cards[0].layers[0].x;
  const repaired=await png(20,10,'blue');const repairFile={asset:'production-results/repaired.png',sha256:hash(repaired)};await atomicFile(assetPath(root,repairFile.asset),repaired);jobs[0].repair={file:repairFile};state=await renderMockups(root,c,jobs,catalog);
  assert.equal(state.cards[0].layers[0].x,moved);assert.ok(state.cards[0].layers.every(l=>l.sourceSHA256===repairFile.sha256));assert.equal((await readMockupState(root,'A')).cards[0].render.sha256,state.cards[0].render.sha256);
  assert.equal((await garmentCanvas(detail,garment,frame)).faces.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
